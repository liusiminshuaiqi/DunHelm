package k8s

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	rbacv1 "k8s.io/api/rbac/v1"
	apierr "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/apimachinery/pkg/util/intstr"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
)

// ---------- metrics-server（节点 CPU/内存使用率数据源，供 DunHelm CPU/内存列 + HPA）----------
//
// 与 node-exporter 的关系：node-exporter 管磁盘（经 apiserver Pod 代理抓 Prometheus 指标），
// metrics-server 管 CPU/内存（经 Kubernetes Metrics API metrics.k8s.io）。两者独立、互不替代、
// 不冲突。本安装器把 metrics-server 作为「节点监控」一键安装的第二个组件。
//
// 本实现对齐官方 components.yaml（k8s-sigs/metrics-server）：
// - secure-port=10250（用 kubelet 同端口，命名端口 https → 10250）
// - args: --kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname
//         + --kubelet-use-node-status-port + --kubelet-insecure-tls + --metric-resolution=15s
// - APIService insecureSkipTLSVerify=true（自签证书必须，否则聚合层 TLS 校验失败 → 当前 manifest 没填这个导致「the server is currently unable to handle the request」）
// - 含 system:aggregated-metrics-reader ClusterRole（带 aggregate-to-admin/edit/view 标签，
//   让默认 admin/edit/view 能用 kubectl top；缺它 HPA / kubectl top 角色权限失败）
// - labels: k8s-app=metrics-server（与官方一致，避免与 Selector 不匹配导致 endpoints 为空）
// - priorityClassName=system-cluster-critical + nodeSelector=kubernetes.io/os=linux + 安全上下文
//
// 镜像默认走本地仓库（dockerhub.kubekey.local/metrics-server/metrics-server:v0.9.0），
// 便于内网/离线环境；如要切回官方 registry.k8s.io，修改 msImage 即可。
const (
	msNS         = "kube-system"
	msName       = "metrics-server"
	msLabelKey   = "k8s-app"
	msLabelValue = "metrics-server"
	msImage      = "dockerhub.kubekey.local/metrics-server/metrics-server:v0.9.0"
	msPort       = 10250
	msAPIGroup   = "metrics.k8s.io"
	msAPIVersion = "v1beta1"
	msAPIName    = "v1beta1.metrics.k8s.io"
)

// apiServiceGVR apiregistration.k8s.io/v1 APIService 的 GVR（用于 dynamic client）
var apiServiceGVR = schema.GroupVersionResource{Group: "apiregistration.k8s.io", Version: "v1", Resource: "apiservices"}

// labels 返回统一的 label 集合
func msLabels() map[string]string {
	return map[string]string{msLabelKey: msLabelValue}
}

// InstallMetricsServer 在集群一键部署 metrics-server（对齐官方 components.yaml）。
// 幂等：所有资源「存在则跳过/更新镜像」；任何资源创建失败返回明确错误。
// 关键修复（相对早期实现）：
//  1. secure-port 改为 10250（与官方一致，命名端口 https → 10250）
//  2. args 增加 --kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname + --metric-resolution=15s
//  3. APIService 加 insecureSkipTLSVerify: true（自签证书必需，否则聚合层 TLS 校验失败）
//  4. 增加 system:aggregated-metrics-reader ClusterRole（默认 admin/edit/view 用 kubectl top）
//  5. labels 统一为 k8s-app=metrics-server（Selector 匹配，避免 Service endpoints 为空）
func (m *Manager) InstallMetricsServer(cid uint) error {
	cs, err := m.Clientset(cid)
	if err != nil {
		return err
	}
	restCfg, err := m.RestConfig(cid)
	if err != nil {
		return err
	}
	dc, err := dynamic.NewForConfig(restCfg)
	if err != nil {
		return err
	}
	apiGVR := apiServiceGVR
	ctx := context.TODO()

	// 1) ServiceAccount
	sa := &corev1.ServiceAccount{
		ObjectMeta: metav1.ObjectMeta{Name: msName, Namespace: msNS, Labels: msLabels()},
	}
	if e := createIfAbsent(cs.CoreV1().ServiceAccounts(msNS).Create, ctx, sa, cs.CoreV1().ServiceAccounts(msNS).Get); e != nil {
		return fmt.Errorf("创建 ServiceAccount 失败: %w", e)
	}

	// 2) ClusterRole system:metrics-server（Deployment 真正要用的：拉取 node/pod metrics）
	cr := &rbacv1.ClusterRole{
		ObjectMeta: metav1.ObjectMeta{Name: "system:metrics-server", Labels: msLabels()},
		Rules: []rbacv1.PolicyRule{
			{APIGroups: []string{""}, Resources: []string{"nodes/metrics"}, Verbs: []string{"get"}},
			{APIGroups: []string{""}, Resources: []string{"pods", "nodes"}, Verbs: []string{"get", "list", "watch"}},
		},
	}
	if e := createClusterObj(
		func() error { _, e := cs.RbacV1().ClusterRoles().Create(ctx, cr, metav1.CreateOptions{}); return e },
		func() error { _, e := cs.RbacV1().ClusterRoles().Get(ctx, "system:metrics-server", metav1.GetOptions{}); return e },
	); e != nil {
		return fmt.Errorf("创建 ClusterRole system:metrics-server 失败: %w", e)
	}

	// 3) ClusterRole system:aggregated-metrics-reader（聚合角色，admin/edit/view 通过它读 metrics）
	// aggregate-to-* 标签是关键：默认 admin/edit/view ClusterRole 会自动聚合此角色权限
	aggCR := &rbacv1.ClusterRole{
		ObjectMeta: metav1.ObjectMeta{
			Name: "system:aggregated-metrics-reader",
			Labels: map[string]string{
				msLabelKey:                                              msLabelValue,
				"rbac.authorization.k8s.io/aggregate-to-admin":          "true",
				"rbac.authorization.k8s.io/aggregate-to-edit":           "true",
				"rbac.authorization.k8s.io/aggregate-to-view":           "true",
			},
		},
		Rules: []rbacv1.PolicyRule{{
			APIGroups: []string{msAPIGroup},
			Resources: []string{"pods", "nodes"},
			Verbs:     []string{"get", "list", "watch"},
		}},
	}
	if e := createClusterObj(
		func() error { _, e := cs.RbacV1().ClusterRoles().Create(ctx, aggCR, metav1.CreateOptions{}); return e },
		func() error { _, e := cs.RbacV1().ClusterRoles().Get(ctx, "system:aggregated-metrics-reader", metav1.GetOptions{}); return e },
	); e != nil {
		return fmt.Errorf("创建 ClusterRole system:aggregated-metrics-reader 失败: %w", e)
	}

	// 4) ClusterRoleBinding system:metrics-server → system:metrics-server
	if e := createClusterObj(
		func() error {
			_, e := cs.RbacV1().ClusterRoleBindings().Create(ctx, &rbacv1.ClusterRoleBinding{
				ObjectMeta: metav1.ObjectMeta{Name: "system:metrics-server", Labels: msLabels()},
				RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "ClusterRole", Name: "system:metrics-server"},
				Subjects:   []rbacv1.Subject{{Kind: "ServiceAccount", Name: msName, Namespace: msNS}},
			}, metav1.CreateOptions{})
			return e
		},
		func() error { _, e := cs.RbacV1().ClusterRoleBindings().Get(ctx, "system:metrics-server", metav1.GetOptions{}); return e },
	); e != nil {
		return fmt.Errorf("创建 ClusterRoleBinding system:metrics-server 失败: %w", e)
	}

	// 5) ClusterRoleBinding metrics-server:system:auth-delegator → system:auth-delegator（聚合层鉴权委托）
	if e := createClusterObj(
		func() error {
			_, e := cs.RbacV1().ClusterRoleBindings().Create(ctx, &rbacv1.ClusterRoleBinding{
				ObjectMeta: metav1.ObjectMeta{Name: "metrics-server:system:auth-delegator", Labels: msLabels()},
				RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "ClusterRole", Name: "system:auth-delegator"},
				Subjects:   []rbacv1.Subject{{Kind: "ServiceAccount", Name: msName, Namespace: msNS}},
			}, metav1.CreateOptions{})
			return e
		},
		func() error { _, e := cs.RbacV1().ClusterRoleBindings().Get(ctx, "metrics-server:system:auth-delegator", metav1.GetOptions{}); return e },
	); e != nil {
		return fmt.Errorf("创建 auth-delegator 绑定失败: %w", e)
	}

	// 6) ClusterRole extension-apiserver-authentication-reader + RoleBinding（kube-system）
	//
	// 关键修复：官方 kube-apiserver 会自动创建一个 namespace-scoped Role `extension-apiserver-authentication-reader`
	// 用于给聚合层读 requestheader CA configmap。但精简发行版（kubesphere/kubekey 自建集群）下可能没自动建，
	// metrics-server 启动时报：
	//   `clusterrole.rbac.authorization.k8s.io "extension-apiserver-authentication-reader" not found`
	// → exit 1 → CrashLoopBackOff。
	//
	// 关键：verbs 必须是 get/list/watch（不带 resourceNames）。metrics-server 用 client-go reflector
	// LIST/WATCH 整个 configmaps（认证 CA 变化时需要重新发现），只给 get + 单个 resourceName 不够——
	// 会出现 "configmaps is forbidden: User ... cannot LIST resource configmaps" 的持续反射器报错，
	// 进而 apiserver 聚合层报 "the server is currently unable to handle the request"。
	authReaderCR := &rbacv1.ClusterRole{
		ObjectMeta: metav1.ObjectMeta{Name: "extension-apiserver-authentication-reader", Labels: msLabels()},
		Rules: []rbacv1.PolicyRule{{
			APIGroups: []string{""},
			Resources: []string{"configmaps"},
			Verbs:     []string{"get", "list", "watch"},
		}},
	}
	// 关键：不是 create-or-skip，而是 create-or-update rules（早期 manifest 只给 get + resourceNames，
	// 那个权限对 metrics-server reflector LIST/WATCH 不够，会持续报 forbidden）。
	if existing, e := cs.RbacV1().ClusterRoles().Get(ctx, "extension-apiserver-authentication-reader", metav1.GetOptions{}); e != nil {
		if apierr.IsNotFound(e) {
			if _, e := cs.RbacV1().ClusterRoles().Create(ctx, authReaderCR, metav1.CreateOptions{}); e != nil {
				return fmt.Errorf("创建 ClusterRole extension-apiserver-authentication-reader 失败: %w", e)
			}
		} else {
			return fmt.Errorf("查询 ClusterRole extension-apiserver-authentication-reader 失败: %w", e)
		}
	} else {
		existing.Labels = authReaderCR.Labels
		existing.Rules = authReaderCR.Rules
		if _, e := cs.RbacV1().ClusterRoles().Update(ctx, existing, metav1.UpdateOptions{}); e != nil {
			return fmt.Errorf("更新 ClusterRole extension-apiserver-authentication-reader 失败: %w", e)
		}
	}
	if e := createNSRoleBinding(cs, ctx, &rbacv1.RoleBinding{
		ObjectMeta: metav1.ObjectMeta{Name: "metrics-server-auth-reader", Namespace: msNS, Labels: msLabels()},
		RoleRef:    rbacv1.RoleRef{APIGroup: "rbac.authorization.k8s.io", Kind: "ClusterRole", Name: "extension-apiserver-authentication-reader"},
		Subjects:   []rbacv1.Subject{{Kind: "ServiceAccount", Name: msName, Namespace: msNS}},
	}); e != nil {
		return fmt.Errorf("创建 auth-reader 绑定失败: %w", e)
	}

	// 7) Service（apiserver 聚合层通过此 Service 访问 metrics-server；命名端口 https → 10250）
	svc := &corev1.Service{
		ObjectMeta: metav1.ObjectMeta{Name: msName, Namespace: msNS, Labels: msLabels()},
		Spec: corev1.ServiceSpec{
			Selector: msLabels(),
			Ports: []corev1.ServicePort{{
				Name: "https", AppProtocol: ptrString("https"), Port: 443, TargetPort: intstr.FromString("https"), Protocol: corev1.ProtocolTCP,
			}},
		},
	}
	if existing, e := cs.CoreV1().Services(msNS).Get(ctx, msName, metav1.GetOptions{}); e == nil {
		existing.Labels = svc.Labels
		existing.Spec.Ports = svc.Spec.Ports
		existing.Spec.Selector = svc.Spec.Selector
		if _, e := cs.CoreV1().Services(msNS).Update(ctx, existing, metav1.UpdateOptions{}); e != nil {
			return fmt.Errorf("更新 Service 失败: %w", e)
		}
	} else if apierr.IsNotFound(e) {
		if _, e := cs.CoreV1().Services(msNS).Create(ctx, svc, metav1.CreateOptions{}); e != nil {
			return fmt.Errorf("创建 Service 失败: %w", e)
		}
	} else {
		return fmt.Errorf("查询 Service 失败: %w", e)
	}

	// 8) Deployment（对齐官方：secure-port=10250、命名端口 https、system-cluster-critical、滚动更新 maxUnavailable=0）
	dep := &appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: msName, Namespace: msNS, Labels: msLabels()},
		Spec: appsv1.DeploymentSpec{
			Selector: &metav1.LabelSelector{MatchLabels: msLabels()},
			Strategy: appsv1.DeploymentStrategy{
				RollingUpdate: &appsv1.RollingUpdateDeployment{MaxUnavailable: &intstr.IntOrString{Type: intstr.Int, IntVal: 0}},
			},
			Template: corev1.PodTemplateSpec{
				ObjectMeta: metav1.ObjectMeta{Labels: msLabels()},
				Spec: corev1.PodSpec{
					ServiceAccountName: msName,
					NodeSelector:       map[string]string{"kubernetes.io/os": "linux"},
					PriorityClassName:  "system-cluster-critical",
					Tolerations:        []corev1.Toleration{{Operator: corev1.TolerationOpExists}},
					SecurityContext: &corev1.PodSecurityContext{
						RunAsNonRoot: ptrBool(true),
						RunAsUser:    ptrInt64(1000),
						SeccompProfile: &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
					},
					Containers: []corev1.Container{{
						Name:  msName,
						Image: msImage,
						ImagePullPolicy: corev1.PullIfNotPresent,
						Args: []string{
							"--cert-dir=/tmp",
							"--secure-port=10250",
							"--kubelet-preferred-address-types=InternalIP,ExternalIP,Hostname",
							"--kubelet-use-node-status-port",
							"--metric-resolution=15s",
							"--kubelet-insecure-tls",
						},
						Ports: []corev1.ContainerPort{{Name: "https", ContainerPort: msPort, Protocol: corev1.ProtocolTCP}},
						VolumeMounts: []corev1.VolumeMount{{Name: "tmp-dir", MountPath: "/tmp"}},
						Resources: corev1.ResourceRequirements{
							Requests: corev1.ResourceList{
								corev1.ResourceCPU:    resourceQuantity("100m"),
								corev1.ResourceMemory: resourceQuantity("200Mi"),
							},
						},
						SecurityContext: &corev1.SecurityContext{
							AllowPrivilegeEscalation: ptrBool(false),
							ReadOnlyRootFilesystem:  ptrBool(true),
							RunAsNonRoot:            ptrBool(true),
							RunAsUser:               ptrInt64(1000),
							Capabilities:            &corev1.Capabilities{Drop: []corev1.Capability{"ALL"}},
							SeccompProfile:          &corev1.SeccompProfile{Type: corev1.SeccompProfileTypeRuntimeDefault},
						},
						LivenessProbe: &corev1.Probe{
							ProbeHandler:        corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{Path: "/livez", Port: intstr.FromString("https"), Scheme: corev1.URISchemeHTTPS}},
							PeriodSeconds:       10,
							FailureThreshold:    3,
						},
						ReadinessProbe: &corev1.Probe{
							ProbeHandler:        corev1.ProbeHandler{HTTPGet: &corev1.HTTPGetAction{Path: "/readyz", Port: intstr.FromString("https"), Scheme: corev1.URISchemeHTTPS}},
							InitialDelaySeconds: 20,
							PeriodSeconds:       10,
							FailureThreshold:    3,
						},
					}},
					Volumes: []corev1.Volume{{Name: "tmp-dir", VolumeSource: corev1.VolumeSource{EmptyDir: &corev1.EmptyDirVolumeSource{}}}},
				},
			},
		},
	}
	if _, e := cs.AppsV1().Deployments(msNS).Get(ctx, msName, metav1.GetOptions{}); e == nil {
		// 已在：删除旧 Deployment 再重建（避免新旧 ReplicaSet 同时存在导致 CrashLoopBackOff 干扰诊断；
		// 以及早期 manifest label/args 与本实现差很多，单纯的 Update 会保留旧 spec.template 残留）。
		// 关键：删除后 Pod 级联清理，老 CrashLoopBackOff 也会一起消失。
		if delErr := cs.AppsV1().Deployments(msNS).Delete(ctx, msName, metav1.DeleteOptions{}); delErr != nil {
			return fmt.Errorf("清理旧 Deployment 失败: %w", delErr)
		}
		// 等老 ReplicaSet/Pod 真正消失（避免新 Deployment 立刻拿到同名 Pod 进入 ImagePullBackOff）
		for wait := 0; wait < 30; wait++ {
			time.Sleep(1 * time.Second)
			if _, getErr := cs.AppsV1().Deployments(msNS).Get(ctx, msName, metav1.GetOptions{}); apierr.IsNotFound(getErr) {
				break
			}
		}
		if _, e := cs.AppsV1().Deployments(msNS).Create(ctx, dep, metav1.CreateOptions{}); e != nil {
			return fmt.Errorf("重建 Deployment 失败: %w", e)
		}
	} else if apierr.IsNotFound(e) {
		if _, e := cs.AppsV1().Deployments(msNS).Create(ctx, dep, metav1.CreateOptions{}); e != nil {
			return fmt.Errorf("创建 Deployment 失败: %w", e)
		}
	} else {
		return fmt.Errorf("查询 Deployment 失败: %w", e)
	}

	// 9) APIService v1beta1.metrics.k8s.io
	//    关键修复：insecureSkipTLSVerify: true（metrics-server 默认自签证书，apiserver 必须跳过 TLS 校验；
	//    缺失时聚合 API 返回「the server is currently unable to handle the request」，
	//    这正是早期 manifest 一直未就绪的根因）。
	apiName := msAPIVersion + "." + msAPIGroup
	apiObj := &unstructured.Unstructured{Object: map[string]interface{}{
		"apiVersion": "apiregistration.k8s.io/v1",
		"kind":       "APIService",
		"metadata": map[string]interface{}{
			"name":   apiName,
			"labels": map[string]interface{}{msLabelKey: msLabelValue},
		},
		"spec": map[string]interface{}{
			"service": map[string]interface{}{
				"name":      msName,
				"namespace": msNS,
			},
			"group":                   msAPIGroup,
			"version":                 msAPIVersion,
			"groupPriorityMinimum":    int64(100),
			"versionPriority":         int64(100),
			"insecureSkipTLSVerify":   true,
		},
	}}
	if _, e := dc.Resource(apiGVR).Get(ctx, apiName, metav1.GetOptions{}); e != nil {
		if apierr.IsNotFound(e) {
			if _, e := dc.Resource(apiGVR).Create(ctx, apiObj, metav1.CreateOptions{}); e != nil && !apierr.IsAlreadyExists(e) {
				return fmt.Errorf("创建 APIService 失败: %w", e)
			}
		} else {
			return fmt.Errorf("查询 APIService 失败: %w", e)
		}
	} else {
		// 已在：删除重建。理由：APIService 一旦进入 Available=False（早期 manifest 漏 insecureSkipTLSVerify），
		// 即便 Update spec 也未必让 apiserver 重新探测聚合层是否健康；最稳妥是 Delete→Create 让 apiserver 立刻按新 spec 重连 metrics-server。
		if delErr := dc.Resource(apiGVR).Delete(ctx, apiName, metav1.DeleteOptions{}); delErr != nil && !apierr.IsNotFound(delErr) {
			return fmt.Errorf("清理旧 APIService 失败: %w", delErr)
		}
		// 等真正消失
		for wait := 0; wait < 15; wait++ {
			time.Sleep(1 * time.Second)
			if _, getErr := dc.Resource(apiGVR).Get(ctx, apiName, metav1.GetOptions{}); apierr.IsNotFound(getErr) {
				break
			}
		}
		if _, e := dc.Resource(apiGVR).Create(ctx, apiObj, metav1.CreateOptions{}); e != nil && !apierr.IsAlreadyExists(e) {
			return fmt.Errorf("重建 APIService 失败: %w", e)
		}
	}
	return nil
}

// MetricsServerStatus 返回 metrics-server 安装/就绪状态。
// ready 以「能否成功 List NodeMetrics（Metrics API 真实可用）」判定，最贴近实际使用。
// 同步返回 Pod 列表（最多 3 个）便于前端展示真实拉取/启动失败原因。
func (m *Manager) MetricsServerStatus(cid uint) (installed bool, ready bool, message string, pods []MetricsServerPod, err error) {
	cs, e := m.Clientset(cid)
	if e != nil {
		return false, false, "", nil, e
	}
	ctx := context.TODO()
	_, e = cs.AppsV1().Deployments(msNS).Get(ctx, msName, metav1.GetOptions{})
	if e != nil {
		if apierr.IsNotFound(e) {
			return false, false, "尚未安装 metrics-server", nil, nil
		}
		return false, false, "", nil, e
	}
	installed = true
	// 抓 Pod 真实状态：按 Deployment selector（k8s-app=metrics-server）拉取，
	// 这样无论历史 Pod 用的是什么 label（早期 manifest 是 app.kubernetes.io/name=metrics-server）都能命中。
	if pl, perr := cs.CoreV1().Pods(msNS).List(ctx, metav1.ListOptions{LabelSelector: msLabelKey + "=" + msLabelValue}); perr == nil {
		for i, p := range pl.Items {
			if i >= 3 {
				break
			}
			phase := string(p.Status.Phase)
			reason := ""
			if p.Status.ContainerStatuses != nil && len(p.Status.ContainerStatuses) > 0 {
				cs := p.Status.ContainerStatuses[0]
				if cs.State.Waiting != nil {
					reason = cs.State.Waiting.Reason + ": " + cs.State.Waiting.Message
				} else if cs.State.Running != nil {
					reason = "Running"
				} else if cs.State.Terminated != nil {
					reason = cs.State.Terminated.Reason + " (exit=" + strconv.Itoa(int(cs.State.Terminated.ExitCode)) + "): " + cs.State.Terminated.Message
				}
			}
			pods = append(pods, MetricsServerPod{Name: p.Name, Node: p.Spec.NodeName, Phase: phase, Reason: reason})
		}
	}
	// 兜底：拉每个 Pod 的 events + 上一次容器 logs（找到真实启动失败原因）
	for i := range pods {
		evList, eerr := cs.CoreV1().Events(msNS).List(ctx, metav1.ListOptions{
			FieldSelector: "involvedObject.kind=Pod,involvedObject.name=" + pods[i].Name,
		})
		if eerr == nil && evList != nil {
			var lastWarn, lastNormal string
			for _, e := range evList.Items {
				if e.Type == "Warning" {
					if e.LastTimestamp.Time.After(parseTimeOrZero(lastWarn)) {
						lastWarn = e.LastTimestamp.Time.Format(time.RFC3339) + " " + e.Reason + ": " + e.Message
					}
				} else if e.Type == "Normal" && e.Reason == "Pulled" {
					lastNormal = e.Message
				}
			}
			if lastWarn != "" {
				pods[i].Reason = "LastWarn: " + lastWarn
			}
			if lastNormal != "" {
				pods[i].Reason += " | " + lastNormal
			}
		}
		// 拉上一次退出的容器 logs（容器启动失败时这是最直接的信息）
		if strings.Contains(pods[i].Reason, "BackOff") || strings.Contains(pods[i].Reason, "CrashLoop") {
			logReq := cs.CoreV1().Pods(msNS).GetLogs(pods[i].Name, &corev1.PodLogOptions{
				Container:  msName,
				Previous:   true,
				Timestamps: false,
			})
			if stream, eerr := logReq.Stream(ctx); eerr == nil {
				buf := make([]byte, 4096)
				n, _ := stream.Read(buf)
				stream.Close()
				if n > 0 {
					pods[i].Reason += " | LastLog: " + strings.TrimSpace(string(buf[:n]))
				}
			}
		} else if strings.HasPrefix(pods[i].Reason, "Running") {
			// 容器 Running 但 metrics API 仍不可用：抓当前 logs（看是否有"unable to fully scrape"等提示）
			logReq := cs.CoreV1().Pods(msNS).GetLogs(pods[i].Name, &corev1.PodLogOptions{
				Container:  msName,
				Previous:   false,
				TailLines:  ptrInt64(20),
				Timestamps: false,
			})
			if stream, eerr := logReq.Stream(ctx); eerr == nil {
				buf := make([]byte, 4096)
				n, _ := stream.Read(buf)
				stream.Close()
				if n > 0 {
					pods[i].Reason += " | CurrentLog: " + strings.TrimSpace(string(buf[:n]))
				}
			}
		}
	}
	// 兜底：如果 selector 没命中（例如早期 manifest 用了不同 label），按 Deployment owner 拉
	if len(pods) == 0 {
		if pl, perr := cs.CoreV1().Pods(msNS).List(ctx, metav1.ListOptions{}); perr == nil {
			for _, p := range pl.Items {
				for _, o := range p.OwnerReferences {
					if o.Kind == "ReplicaSet" && strings.Contains(p.Name, msName) {
						phase := string(p.Status.Phase)
						reason := ""
						if p.Status.ContainerStatuses != nil && len(p.Status.ContainerStatuses) > 0 {
							cs := p.Status.ContainerStatuses[0]
							if cs.State.Waiting != nil {
								reason = cs.State.Waiting.Reason + ": " + cs.State.Waiting.Message
							} else if cs.State.Running != nil {
								reason = "Running"
							}
						}
						pods = append(pods, MetricsServerPod{Name: p.Name, Node: p.Spec.NodeName, Phase: phase, Reason: reason})
						break
					}
				}
				if len(pods) >= 3 {
					break
				}
			}
		}
	}
	// 诊断 APIService 自身条件（更权威：为什么聚合层返回"server is currently unable to handle the request"）
	if restCfg2, rerr := m.RestConfig(cid); rerr == nil {
		if dc2, derr := dynamic.NewForConfig(restCfg2); derr == nil {
			if apiObj, ae := dc2.Resource(apiServiceGVR).Get(ctx, msAPIName, metav1.GetOptions{}); ae == nil {
				if statusMap, ok := apiObj.Object["status"].(map[string]interface{}); ok {
					if conds, ok := statusMap["conditions"].([]interface{}); ok {
						for _, c := range conds {
							if cm, ok := c.(map[string]interface{}); ok {
								typ, _ := cm["type"].(string)
								st, _ := cm["status"].(string)
								reason, _ := cm["reason"].(string)
								msg, _ := cm["message"].(string)
								if typ == "Available" && st != "True" {
									message = "metrics-server 启动中（APIService " + typ + "=" + st + " · " + reason + ": " + msg + "）"
								}
							}
						}
					}
				}
			}
		}
	}
	// 尝试真正拉取 Metrics API（短超时，避免阻塞）
	mc, mErr := m.MetricsClient(cid)
	if mErr != nil {
		return installed, false, "metrics-server 启动中（等待 Metrics API 就绪）", pods, nil
	}
	ctx2, cancel := context.WithTimeout(ctx, 6*time.Second)
	defer cancel()
	if _, e := mc.MetricsV1beta1().NodeMetricses().List(ctx2, metav1.ListOptions{}); e == nil {
		ready = true
	} else {
		message = "metrics-server 启动中（等待聚合 API 就绪）：" + e.Error()
	}
	return installed, ready, message, pods, nil
}

// MetricsServerPod metrics-server 某个 Pod 的真实状态（供前端展示）
type MetricsServerPod struct {
	Name   string `json:"name"`
	Node   string `json:"node"`
	Phase  string `json:"phase"`
	Reason string `json:"reason"`
}

// ---------- 工具 ----------

func int32Ptr(i int32) *int32 { return &i }

func ptrBool(b bool) *bool       { return &b }
func ptrInt64(i int64) *int64    { return &i }
func ptrString(s string) *string { return &s }

// parseTimeOrZero 解析 RFC3339 时间字符串；解析失败返回零值，便于直接 .After 比较
func parseTimeOrZero(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t
	}
	return time.Time{}
}

// createNSRoleBinding 命名空间内资源「存在则跳过」创建（幂等）
func createNSRoleBinding(cs *kubernetes.Clientset, ctx context.Context, obj *rbacv1.RoleBinding) error {
	if _, e := cs.RbacV1().RoleBindings(obj.Namespace).Create(ctx, obj, metav1.CreateOptions{}); e != nil {
		if apierr.IsAlreadyExists(e) {
			return nil
		}
		return e
	}
	return nil
}