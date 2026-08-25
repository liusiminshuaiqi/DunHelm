package k8s

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	appsv1 "k8s.io/api/apps/v1"
	apierr "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/kubernetes"
)

// ---------- node-exporter（节点磁盘使用率数据源）----------

// node-exporter 是本平台获取「节点磁盘使用率」的唯一数据源：
// K8s 标准 API（含 metrics-server）只暴露 CPU/内存，不暴露磁盘；kubelet /stats/summary
// 只暴露根文件系统、且需要直连 kubelet:10250（用户环境有证书 IP SAN 问题）。
// node-exporter 以 DaemonSet 跑在每个节点上，读取宿主 /proc /sys 得到全部挂载点
// （含根磁盘 / 与数据盘 /data）的文件系统指标，后端经 apiserver→Pod 代理抓取 /metrics，
// 完全不经过 kubelet，绕开了证书坑，且日常读取为零集群写操作（只在安装时写一次）。
const (
	nodeExporterNS     = "kube-system"
	nodeExporterName   = "node-exporter"
	nodeExporterLabel  = "app.kubernetes.io/name=node-exporter"
	nodeExporterImage  = "quay.io/prometheus/node-exporter:v1.8.2"
	nodeExporterPort   = 9100
	// diskMountPoints 需要统计的挂载点：根磁盘 / 与数据盘 /data
	diskMountPoints = "/,/data"
)

// NodeDisk 单节点的双盘使用率（使用率 %）
type NodeDisk struct {
	Root      int  // 根磁盘 (/) 使用率 %
	Data      int  // 数据盘 (/data) 使用率 %
	DataFound bool // 节点上是否存在 /data 挂载点（false 表示该节点无此挂载，非 0% 使用）
	Ready     bool
}

// NodeExporterPod 单节点 node-exporter Pod 的运行状态（供前端安装横幅展示错误）
type NodeExporterPod struct {
	Node   string `json:"node"`
	Phase  string `json:"phase"`
	Reason string `json:"reason"` // ImagePullBackOff 等容器未就绪原因
}

// InstallNodeExporter 在集群中一键部署 node-exporter（SA + ClusterRole + ClusterRoleBinding + DaemonSet）。
// 已在则跳过（幂等）；任何资源创建失败返回明确错误。
func (m *Manager) InstallNodeExporter(cid uint) error {
	cs, err := m.Clientset(cid)
	if err != nil {
		return err
	}
	ctx := context.TODO()

	// 1) ServiceAccount
	sa := &corev1.ServiceAccount{ObjectMeta: metav1.ObjectMeta{Name: nodeExporterName, Namespace: nodeExporterNS}}
	if e := createIfAbsent(cs.CoreV1().ServiceAccounts(nodeExporterNS).Create, ctx, sa, cs.CoreV1().ServiceAccounts(nodeExporterNS).Get); e != nil {
		return fmt.Errorf("创建 ServiceAccount 失败: %w", e)
	}

	// 2) ClusterRole
	cr := &rbacv1.ClusterRole{
		ObjectMeta: metav1.ObjectMeta{Name: nodeExporterName},
		Rules: []rbacv1.PolicyRule{{
			APIGroups: []string{""},
			Resources: []string{"nodes", "nodes/proxy", "services", "endpoints", "pods"},
			Verbs:     []string{"get", "list", "watch"},
		}},
	}
	if e := createClusterObj(
		func() error { _, e := cs.RbacV1().ClusterRoles().Create(ctx, cr, metav1.CreateOptions{}); return e },
		func() error { _, e := cs.RbacV1().ClusterRoles().Get(ctx, nodeExporterName, metav1.GetOptions{}); return e },
	); e != nil {
		return fmt.Errorf("创建 ClusterRole 失败: %w", e)
	}

	// 3) ClusterRoleBinding
	crb := &rbacv1.ClusterRoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: nodeExporterName},
		RoleRef: rbacv1.RoleRef{
			APIGroup: "rbac.authorization.k8s.io",
			Kind:     "ClusterRole",
			Name:     nodeExporterName,
		},
		Subjects: []rbacv1.Subject{{
			Kind:      "ServiceAccount",
			Name:      nodeExporterName,
			Namespace: nodeExporterNS,
		}},
	}
	if e := createClusterObj(
		func() error { _, e := cs.RbacV1().ClusterRoleBindings().Create(ctx, crb, metav1.CreateOptions{}); return e },
		func() error { _, e := cs.RbacV1().ClusterRoleBindings().Get(ctx, nodeExporterName, metav1.GetOptions{}); return e },
	); e != nil {
		return fmt.Errorf("创建 ClusterRoleBinding 失败: %w", e)
	}

	// 4) DaemonSet：hostPath 挂载宿主 /proc /sys /，并以 --path.rootfs=/host 让挂载点标签还原为宿主路径
	ds := &appsv1.DaemonSet{
		ObjectMeta: metav1.ObjectMeta{
			Name:      nodeExporterName,
			Namespace: nodeExporterNS,
			Labels:    map[string]string{"app.kubernetes.io/name": nodeExporterName},
		},
		Spec: appsv1.DaemonSetSpec{
			Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app.kubernetes.io/name": nodeExporterName}},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app.kubernetes.io/name": nodeExporterName}},
				Spec: corev1.PodSpec{
					ServiceAccountName: nodeExporterName,
					// 容忍所有污点，确保 control-plane 节点也能部署
					Tolerations: []corev1.Toleration{{Operator: corev1.TolerationOpExists}},
					Containers: []corev1.Container{{
						Name:  "node-exporter",
						Image: nodeExporterImage,
						Args: []string{
							"--path.procfs=/host/proc",
							"--path.sysfs=/host/sys",
							"--path.rootfs=/host",
							// 排除伪文件系统，避免统计噪音（真实挂载点 / 与 /data 不受影响）
							"--collector.filesystem.mount-points-exclude=^/(dev|proc|sys|run|var/lib/docker|var/lib/containerd)($|/)",
						},
						Ports: []corev1.ContainerPort{{Name: "metrics", ContainerPort: nodeExporterPort, Protocol: corev1.ProtocolTCP}},
						VolumeMounts: []corev1.VolumeMount{
							{Name: "proc", MountPath: "/host/proc", ReadOnly: true},
							{Name: "sys", MountPath: "/host/sys", ReadOnly: true},
							{Name: "root", MountPath: "/host", ReadOnly: true},
						},
						SecurityContext: &corev1.SecurityContext{RunAsUser: int64Ptr(0), RunAsGroup: int64Ptr(0)},
						Resources: corev1.ResourceRequirements{
							Requests: corev1.ResourceList{
								corev1.ResourceCPU:    resourceQuantity("50m"),
								corev1.ResourceMemory: resourceQuantity("60Mi"),
							},
						},
						LivenessProbe: &corev1.Probe{
							ProbeHandler:        corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{Path: "/healthz", Port: intstr.FromInt(nodeExporterPort)}},
							InitialDelaySeconds: 10,
							PeriodSeconds:       30,
						},
					}},
					Volumes: []corev1.Volume{
						{Name: "proc", VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{Path: "/proc"}}},
						{Name: "sys", VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{Path: "/sys"}}},
						{Name: "root", VolumeSource: corev1.VolumeSource{HostPath: &corev1.HostPathVolumeSource{Path: "/"}}},
					},
				},
			},
		},
	}
	// DaemonSet：已存在则更新镜像（支持切换镜像后重装），否则创建
	if existing, e := cs.AppsV1().DaemonSets(nodeExporterNS).Get(ctx, nodeExporterName, metav1.GetOptions{}); e == nil {
		existing.Spec.Template.Spec.Containers[0].Image = nodeExporterImage
		if _, e := cs.AppsV1().DaemonSets(nodeExporterNS).Update(ctx, existing, metav1.UpdateOptions{}); e != nil {
			return fmt.Errorf("更新 DaemonSet 失败: %w", e)
		}
	} else if apierr.IsNotFound(e) {
		if _, e := cs.AppsV1().DaemonSets(nodeExporterNS).Create(ctx, ds, metav1.CreateOptions{}); e != nil {
			return fmt.Errorf("创建 DaemonSet 失败: %w", e)
		}
	} else {
		return fmt.Errorf("查询 DaemonSet 失败: %w", e)
	}
	return nil
}

// NodeExporterStatus 返回 node-exporter 安装/就绪状态，供前端安装横幅展示。
func (m *Manager) NodeExporterStatus(cid uint) (installed bool, ready bool, pods []NodeExporterPod, message string, err error) {
	cs, e := m.Clientset(cid)
	if e != nil {
		return false, false, nil, "", e
	}
	ctx := context.TODO()
	ds, e := cs.AppsV1().DaemonSets(nodeExporterNS).Get(ctx, nodeExporterName, metav1.GetOptions{})
	if e != nil {
		if apierr.IsNotFound(e) {
			return false, false, nil, "尚未安装 node-exporter", nil
		}
		return false, false, nil, "", e
	}
	installed = true
	list, e := cs.CoreV1().Pods(nodeExporterNS).List(ctx, metav1.ListOptions{LabelSelector: nodeExporterLabel})
	if e != nil {
		return installed, false, nil, "", e
	}
	for i := range list.Items {
		p := &list.Items[i]
		np := NodeExporterPod{Node: p.Spec.NodeName, Phase: string(p.Status.Phase)}
		for _, c := range p.Status.ContainerStatuses {
			if c.Ready {
				continue
			}
			// 优先取真实错误信息（如 "failed to pull image ... not found" / "i/o timeout"）
			if c.State.Waiting != nil && c.State.Waiting.Message != "" {
				np.Reason = c.State.Waiting.Message
			} else if c.State.Waiting != nil {
				np.Reason = c.State.Waiting.Reason
			} else if c.LastTerminationState.Waiting != nil && c.LastTerminationState.Waiting.Message != "" {
				np.Reason = c.LastTerminationState.Waiting.Message
			}
		}
		pods = append(pods, np)
	}
	// ready：期望副本数 > 0 且所有期望副本就绪
	if ds.Status.DesiredNumberScheduled > 0 && ds.Status.NumberReady == ds.Status.DesiredNumberScheduled {
		ready = true
	} else {
		message = fmt.Sprintf("node-exporter 启动中（%d/%d 就绪）", ds.Status.NumberReady, ds.Status.DesiredNumberScheduled)
	}
	return installed, ready, pods, message, nil
}

// CollectDisk 为给定节点并行抓取 node-exporter 指标，返回每个节点的双盘使用率。
// node-exporter 未安装或某节点暂无 Pod 时，对应节点 Ready=false（前端降级提示）。
func (m *Manager) CollectDisk(cid uint, nodeNames []string) (map[string]NodeDisk, bool, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, false, err
	}
	ctx := context.TODO()
	list, e := cs.CoreV1().Pods(nodeExporterNS).List(ctx, metav1.ListOptions{LabelSelector: nodeExporterLabel})
	if e != nil {
		// 拿不到列表（如 RBAC 不足）视为未安装，不报错，降级
		return nil, false, nil
	}
	// 节点 → node-exporter Pod 名（仅取 Running）
	podByNode := map[string]string{}
	for i := range list.Items {
		p := &list.Items[i]
		if p.Status.Phase == corev1.PodRunning {
			podByNode[p.Spec.NodeName] = p.Name
		}
	}
	if len(podByNode) == 0 {
		return nil, false, nil
	}

	var (
		mu      sync.Mutex
		wg      sync.WaitGroup
		out     = map[string]NodeDisk{}
		anyReady bool
	)
	for _, name := range nodeNames {
		pod, ok := podByNode[name]
		if !ok {
			continue
		}
		wg.Add(1)
		go func(node, podName string) {
			defer wg.Done()
			d, ok := m.scrapeNodeDisk(cs, podName)
			if !ok {
				return
			}
			mu.Lock()
			out[node] = d
			if d.Ready {
				anyReady = true
			}
			mu.Unlock()
		}(name, pod)
	}
	wg.Wait()
	return out, anyReady, nil
}

// scrapeNodeDisk 经 apiserver→Pod 代理抓取单个 node-exporter 的 /metrics，解析文件系统使用率。
func (m *Manager) scrapeNodeDisk(cs *kubernetes.Clientset, podName string) (NodeDisk, bool) {
	raw, ok := m.rawNodeExporter(cs, podName)
	if !ok {
		return NodeDisk{}, false
	}
	usage := parseFilesystemUsage(raw)
	res := NodeDisk{Ready: true}
	res.Root = usage["/"]
	if v, ok := usage["/data"]; ok {
		res.Data = v
		res.DataFound = true
	}
	return res, true
}

// rawNodeExporter 抓取某 node-exporter Pod 的原始 /metrics 文本（供调试）。
func (m *Manager) rawNodeExporter(cs *kubernetes.Clientset, podName string) (string, bool) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	raw, err := cs.CoreV1().RESTClient().
		Get().
		Resource("pods").
		Namespace(nodeExporterNS).
		Name(podName).
		SubResource("proxy").
		Suffix("metrics").
		Do(ctx).
		Raw()
	if err != nil {
		return "", false
	}
	return string(raw), true
}

// ---------- 工具 ----------

func int64Ptr(i int64) *int64 { return &i }

func resourceQuantity(s string) resource.Quantity {
	q, _ := resource.ParseQuantity(s)
	return q
}

// createIfAbsent 对命名空间内资源做「存在则跳过」的创建（幂等）。
func createIfAbsent(createFn func(context.Context, *corev1.ServiceAccount, metav1.CreateOptions) (*corev1.ServiceAccount, error), ctx context.Context, obj *corev1.ServiceAccount, getFn func(context.Context, string, metav1.GetOptions) (*corev1.ServiceAccount, error)) error {
	if _, e := createFn(ctx, obj, metav1.CreateOptions{}); e != nil {
		if apierr.IsAlreadyExists(e) {
			return nil
		}
		return e
	}
	return nil
}

// createClusterObj 对集群级资源做「存在则跳过」的创建（幂等）；create 失败且非 AlreadyExists 才返回错误。
func createClusterObj(create func() error, get func() error) error {
	if e := create(); e != nil {
		if apierr.IsAlreadyExists(e) {
			return nil
		}
		return e
	}
	_ = get // get 仅用于探测存在性（AlreadyExists 已足够），此处保留以备扩展
	return nil
}

// parseFilesystemUsage 从 node-exporter /metrics 文本解析目标挂载点的「已用百分比」，
// 返回 map[挂载点]使用率%。支持指标：node_filesystem_size_bytes / node_filesystem_avail_bytes。
// 过滤伪文件系统（tmpfs/devtmpfs/overlay/rootfs 等），仅保留真实磁盘挂载。
func parseFilesystemUsage(text string) map[string]int {
	sizeByMP := map[string]map[string]float64{} // mountpoint -> fstype -> size
	availByMP := map[string]map[string]float64{}
	excludeFstype := map[string]bool{
		"tmpfs": true, "devtmpfs": true, "overlay": true, "squashfs": true,
		"aufs": true, "efivarfs": true, "ramfs": true, "rootfs": true,
	}

	for _, line := range strings.Split(text, "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "node_filesystem_size_bytes") && !strings.HasPrefix(line, "node_filesystem_avail_bytes") {
			continue
		}
		if strings.Contains(line, "#") {
			continue
		}
		mp, fstype, val, ok := parseMetric(line)
		if !ok {
			continue
		}
		if excludeFstype[fstype] {
			continue
		}
		if strings.HasPrefix(line, "node_filesystem_size_bytes") {
			if sizeByMP[mp] == nil {
				sizeByMP[mp] = map[string]float64{}
			}
			sizeByMP[mp][fstype] = val
		} else {
			if availByMP[mp] == nil {
				availByMP[mp] = map[string]float64{}
			}
			availByMP[mp][fstype] = val
		}
	}

	calc := func(target string) (int, bool) {
		sizes, ok1 := sizeByMP[target]
		avails, ok2 := availByMP[target]
		if !ok1 || !ok2 {
			return 0, false
		}
		// 同一挂载点可能多个 fstype（极少见），取容量最大的那个
		var sMax, aMax float64
		for fs, s := range sizes {
			if a, ok := avails[fs]; ok && s > sMax {
				sMax, aMax = s, a
			}
		}
		if sMax <= 0 {
			return 0, false
		}
		pct := (sMax - aMax) / sMax * 100
		return int(pct + 0.5), true
	}

	res := map[string]int{}
	if pct, ok := calc("/"); ok {
		res["/"] = pct
	}
	if pct, ok := calc("/data"); ok {
		res["/data"] = pct
	}
	return res
}

// parseMetric 解析一行 Prometheus 指标，返回 mountpoint / fstype / 数值。
// 形如：node_filesystem_size_bytes{device="/dev/sda1",fstype="ext4",mountpoint="/"} 1.07e+11
func parseMetric(line string) (mountpoint, fstype string, value float64, ok bool) {
	// 分离左(名称+标签) 与 右(数值)
	sp := strings.LastIndex(line, " ")
	if sp < 0 {
		return "", "", 0, false
	}
	valStr := strings.TrimSpace(line[sp+1:])
	v, e := strconv.ParseFloat(valStr, 64)
	if e != nil {
		return "", "", 0, false
	}
	left := strings.TrimSpace(line[:sp])
	// 提取标签块
	lb := strings.Index(left, "{")
	rb := strings.LastIndex(left, "}")
	if lb < 0 || rb < 0 || rb < lb {
		return "", "", 0, false
	}
	labels := left[lb+1 : rb]
	for _, kv := range strings.Split(labels, ",") {
		kv = strings.TrimSpace(kv)
		eq := strings.Index(kv, "=")
		if eq < 0 {
			continue
		}
		k := strings.TrimSpace(kv[:eq])
		val := strings.Trim(kv[eq+1:], `"`)
		switch k {
		case "mountpoint":
			mountpoint = val
		case "fstype":
			fstype = val
		}
	}
	if mountpoint == "" {
		return "", "", 0, false
	}
	return mountpoint, fstype, v, true
}
