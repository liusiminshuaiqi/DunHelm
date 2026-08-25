// e2eworkload —— 工作负载写操作的端到端验证（一次性工具，验证完可删除本目录）。
//
// 原则：**只操作自己新建的测试 Deployment**，绝不触碰用户已有的真实负载。
//   - 命名带 kubehelm-e2e- 前缀 + 标签 kubehelm.io/e2e=true，便于识别
//   - 无论成功失败，结束时都会删除测试资源（-keep 可保留用于人工观察）
//
// 用法：
//
//	go run ./cmd/e2eworkload -cluster 5 -ns default
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"time"

	"kubehelm/server/internal/config"
	"kubehelm/server/internal/db"
	"kubehelm/server/internal/k8s"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

const testName = "kubehelm-e2e-rollout"

func main() {
	var clusterID uint
	var ns, image string
	var keep bool
	flag.UintVar(&clusterID, "cluster", 5, "集群 ID")
	flag.StringVar(&ns, "ns", "default", "命名空间")
	flag.StringVar(&image, "image", "", "测试镜像（留空则自动从集群里挑一个已在运行的镜像）")
	flag.BoolVar(&keep, "keep", false, "结束后保留测试资源（默认删除）")
	flag.Parse()

	database := db.Init(config.Load())
	mgr := k8s.NewManager(database)
	cs, err := mgr.Clientset(clusterID)
	if err != nil {
		fatal("连接集群失败: %v", err)
	}
	ctx := context.Background()

	// 挑一个节点上已有的镜像，避免因外网不通导致 ImagePullBackOff
	if image == "" {
		pods, e := cs.CoreV1().Pods("").List(ctx, metav1.ListOptions{Limit: 200})
		if e == nil {
			for i := range pods.Items {
				p := &pods.Items[i]
				if p.Status.Phase == corev1.PodRunning && len(p.Spec.Containers) > 0 {
					image = p.Spec.Containers[0].Image
					break
				}
			}
		}
	}
	if image == "" {
		fatal("未能自动确定测试镜像，请用 -image 指定")
	}
	fmt.Printf("集群 #%d / 命名空间 %s / 测试镜像 %s\n\n", clusterID, ns, image)

	// 清理可能的历史残留后重新创建
	_ = cs.AppsV1().Deployments(ns).Delete(ctx, testName, metav1.DeleteOptions{})
	waitGone(ctx, cs.AppsV1().Deployments(ns).Get, testName)

	cleanup := func() {
		if keep {
			fmt.Printf("\n[保留] 测试资源 %s/%s 未删除（-keep）\n", ns, testName)
			return
		}
		if e := cs.AppsV1().Deployments(ns).Delete(ctx, testName, metav1.DeleteOptions{}); e != nil {
			fmt.Printf("\n[清理失败] 请手动删除 %s/%s: %v\n", ns, testName, e)
			return
		}
		fmt.Printf("\n[已清理] 测试 Deployment %s/%s 已删除\n", ns, testName)
	}
	defer cleanup()

	replicas := int32(2)
	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{
			Name:      testName,
			Namespace: ns,
			Labels:    map[string]string{"kubehelm.io/e2e": "true", "app": testName},
		},
		Spec: appsv1.DeploymentSpec{
			Replicas: &replicas,
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": testName}},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": testName, "kubehelm.io/e2e": "true"}},
				Spec: corev1.PodSpec{
					TerminationGracePeriodSeconds: ptr(int64(1)),
					Containers: []corev1.Container{{
						Name:            "main",
						Image:           image,
						ImagePullPolicy: corev1.PullIfNotPresent,
						Command:         []string{"/bin/sh", "-c", "sleep 3600"},
					}},
				},
			},
		},
	}
	if _, e := cs.AppsV1().Deployments(ns).Create(ctx, dep, metav1.CreateOptions{}); e != nil {
		fatal("创建测试 Deployment 失败: %v", e)
	}
	fmt.Printf("已创建测试 Deployment %s/%s (2 副本)\n", ns, testName)
	if !waitFor(ctx, mgr, clusterID, ns, "就绪", 90*time.Second, func(r *k8s.RolloutStatus, _ []k8s.PodInfo) bool {
		return r != nil && r.Ready == 2
	}) {
		fatal("测试 Deployment 未能就绪，中止（可能镜像不可用）")
	}
	snapshot(mgr, clusterID, ns, "初始状态")

	// ---- 1. 暂停 = 缩容到 0 ----
	fmt.Println("\n=== 1) 暂停（期望：副本缩容为 0，Pod 全部消失）===")
	if e := mgr.ActionWorkload(clusterID, ns, testName, "deployment", "pause", nil); e != nil {
		fatal("pause 失败: %v", e)
	}
	ok1 := waitFor(ctx, mgr, clusterID, ns, "缩容到 0", 60*time.Second, func(r *k8s.RolloutStatus, pods []k8s.PodInfo) bool {
		return r != nil && r.Desired == 0 && r.Paused && livePods(pods) == 0
	})
	snapshot(mgr, clusterID, ns, "暂停后")
	d, _ := cs.AppsV1().Deployments(ns).Get(ctx, testName, metav1.GetOptions{})
	fmt.Printf("  spec.replicas=%d  记录的原副本数注解=%q\n", *d.Spec.Replicas, d.Annotations["kubehelm.io/replicas-before-pause"])
	report("暂停缩容到 0", ok1 && *d.Spec.Replicas == 0 && d.Annotations["kubehelm.io/replicas-before-pause"] == "2")

	// ---- 2. 恢复 = 还原副本数 ----
	fmt.Println("\n=== 2) 恢复（期望：还原为 2 副本，注解被清除）===")
	if e := mgr.ActionWorkload(clusterID, ns, testName, "deployment", "resume", nil); e != nil {
		fatal("resume 失败: %v", e)
	}
	ok2 := waitFor(ctx, mgr, clusterID, ns, "恢复 2 副本", 90*time.Second, func(r *k8s.RolloutStatus, _ []k8s.PodInfo) bool {
		return r != nil && r.Desired == 2 && r.Ready == 2
	})
	d, _ = cs.AppsV1().Deployments(ns).Get(ctx, testName, metav1.GetOptions{})
	_, annoLeft := d.Annotations["kubehelm.io/replicas-before-pause"]
	snapshot(mgr, clusterID, ns, "恢复后")
	fmt.Printf("  spec.replicas=%d  注解是否残留=%v\n", *d.Spec.Replicas, annoLeft)
	report("恢复到原副本数且清除注解", ok2 && *d.Spec.Replicas == 2 && !annoLeft)

	// ---- 3. 重启：观察新旧 Pod 交替 ----
	fmt.Println("\n=== 3) 重启（期望：能观察到新 Pod 创建 + 旧 Pod 终止）===")
	before := map[string]bool{}
	if pods, _, e := mgr.PodsForWorkload(clusterID, ns, testName, "deployment"); e == nil {
		for _, p := range pods {
			before[p.Name] = true
		}
	}
	if e := mgr.ActionWorkload(clusterID, ns, testName, "deployment", "restart", nil); e != nil {
		fatal("restart 失败: %v", e)
	}
	sawProgressing, sawNewPod, sawOldVersion, sawTerminating := false, false, false, false
	deadline := time.Now().Add(120 * time.Second)
	for time.Now().Before(deadline) {
		pods, r, e := mgr.PodsForWorkload(clusterID, ns, testName, "deployment")
		if e == nil && r != nil {
			if r.Progressing {
				sawProgressing = true
			}
			for _, p := range pods {
				if !before[p.Name] {
					sawNewPod = true
				}
				if !p.Updated {
					sawOldVersion = true
				}
				if p.Deleting {
					sawTerminating = true
				}
			}
			if !r.Progressing && r.Ready == 2 && r.Updated == 2 {
				allNew := true
				for _, p := range pods {
					if before[p.Name] {
						allNew = false
					}
				}
				if allNew {
					break
				}
			}
		}
		time.Sleep(700 * time.Millisecond)
	}
	snapshot(mgr, clusterID, ns, "重启完成")
	fmt.Printf("  过程中观测到：滚动中状态=%v  新建Pod=%v  旧版本Pod=%v  终止中Pod=%v\n",
		sawProgressing, sawNewPod, sawOldVersion, sawTerminating)
	report("重启过程可被接口观测到（前端据此渲染进度）", sawProgressing && sawNewPod)

	// ---- 4. DaemonSet 暂停应被明确拒绝 ----
	fmt.Println("\n=== 4) DaemonSet 暂停（期望：明确报错，不做任何写入）===")
	e := mgr.ActionWorkload(clusterID, ns, testName, "daemonset", "pause", nil)
	fmt.Printf("  返回: %v\n", e)
	report("DaemonSet 暂停被拒绝", e != nil)
}

func livePods(pods []k8s.PodInfo) int {
	n := 0
	for _, p := range pods {
		if !p.Deleting {
			n++
		}
	}
	return n
}

func snapshot(mgr *k8s.Manager, cid uint, ns, label string) {
	pods, r, e := mgr.PodsForWorkload(cid, ns, testName, "deployment")
	if e != nil {
		fmt.Printf("  [%s] 查询失败: %v\n", label, e)
		return
	}
	if r != nil {
		fmt.Printf("  [%s] desired=%d ready=%d updated=%d available=%d paused=%v progressing=%v | %s\n",
			label, r.Desired, r.Ready, r.Updated, r.Available, r.Paused, r.Progressing, r.Message)
	}
	for _, p := range pods {
		tag := "旧版本"
		if p.Updated {
			tag = "最新"
		}
		if p.Deleting {
			tag = "终止中"
		}
		fmt.Printf("      - %-46s %-10s ready=%-5v age=%-6s [%s]\n", p.Name, p.Status, p.Ready, p.Age, tag)
	}
	if len(pods) == 0 {
		fmt.Println("      (无 Pod)")
	}
}

func waitFor(_ context.Context, mgr *k8s.Manager, cid uint, ns, what string, timeout time.Duration,
	cond func(*k8s.RolloutStatus, []k8s.PodInfo) bool) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		pods, r, e := mgr.PodsForWorkload(cid, ns, testName, "deployment")
		if e == nil && cond(r, pods) {
			return true
		}
		time.Sleep(time.Second)
	}
	fmt.Printf("  [超时] 等待「%s」超过 %s\n", what, timeout)
	return false
}

func waitGone(ctx context.Context, get func(context.Context, string, metav1.GetOptions) (*appsv1.Deployment, error), name string) {
	for i := 0; i < 30; i++ {
		if _, e := get(ctx, name, metav1.GetOptions{}); e != nil {
			return
		}
		time.Sleep(time.Second)
	}
}

func report(name string, ok bool) {
	mark := "✅ PASS"
	if !ok {
		mark = "❌ FAIL"
	}
	fmt.Printf("  %s  %s\n", mark, name)
}

func ptr[T any](v T) *T { return &v }

func fatal(f string, a ...any) {
	fmt.Fprintf(os.Stderr, "FATAL: "+f+"\n", a...)
	os.Exit(1)
}
