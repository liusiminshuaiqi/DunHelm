package k8s

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierr "k8s.io/apimachinery/pkg/api/errors"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/intstr"
)

// CreateWorkloadReq 创建工作负载的请求参数（与前端「创建工作负载」表单字段一一对齐）。
type CreateWorkloadReq struct {
	Kind      string // Deployment | StatefulSet | DaemonSet | Job | CronJob
	Name      string
	Namespace string
	Replicas  int32
	Image     string

	// 资源限制（limit）+ 资源请求（request），均为可选
	CPU    string // 毫核（millicores），如 "200" → 200m
	Mem    string // 如 "512Mi"
	CPUReq string // 资源请求 CPU（毫核）
	MemReq string // 资源请求 内存

	// 容器端口列表（每条 = name/containerPort/protocol，可选 targetPort）
	Ports []PortReq

	// 环境变量（普通 KV，不支持 ConfigMap/SecretValueFrom，简化场景）
	Env []EnvReq

	// 启动命令 / 参数（覆盖镜像 ENTRYPOINT/CMD）
	Command []string
	Args    []string

	Schedule string // 仅 CronJob 需要，如 "*/5 * * * *"

	// 健康检查（探针）：存活 / 就绪 / 启动，均为可选；填了才下发。
	LivenessProbe  *ProbeReq
	ReadinessProbe *ProbeReq
	StartupProbe   *ProbeReq

	// 存储卷挂载：PVC / emptyDir / hostPath / configMap / secret，均为可选。
	Volumes []VolumeReq

	// 调度（可选）：Pod 优先级类名 + 节点选择器。
	PriorityClassName string
	NodeSelector      map[string]string
}

// PortReq 容器端口定义
type PortReq struct {
	Name          string `json:"name"`          // 可选，K8s 多端口必须命名；空时自动生成 `port-<n>`
	ContainerPort int32  `json:"containerPort"` // 容器内端口（必填，1-65535）
	Protocol      string `json:"protocol"`      // TCP / UDP / SCTP，缺省 TCP
	HostPort      int32  `json:"hostPort"`      // 0 表示不暴露宿主机端口
}

// EnvReq 普通环境变量
type EnvReq struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

// ProbeReq 容器健康检查探针（存活 / 就绪 / 启动共用结构）。
// Type ∈ {http, tcp, exec}；阈值类字段 0 表示交由 K8s 取默认值（不显式设置）。
type ProbeReq struct {
	Type string `json:"type"` // http | tcp | exec
	// HTTP GET 探针
	Path   string `json:"path"`
	Port   int32  `json:"port"`
	Scheme string `json:"scheme"` // HTTP / HTTPS，缺省 HTTP
	// Exec 探针
	Command []string `json:"command"`
	// 通用阈值（秒 / 次数）；0 表示不设置（用 K8s 默认）
	InitialDelaySeconds int32 `json:"initialDelaySeconds"`
	PeriodSeconds       int32 `json:"periodSeconds"`
	TimeoutSeconds      int32 `json:"timeoutSeconds"`
	FailureThreshold    int32 `json:"failureThreshold"`
	SuccessThreshold    int32 `json:"successThreshold"`
}

// VolumeReq 存储卷定义 + 挂载路径（创建向导里一卷一挂，1:1）。
// Type ∈ {pvc, emptyDir, hostPath, configMap, secret}
type VolumeReq struct {
	Name string `json:"name"` // 卷名（容器内引用名，需合法 DNS-1123）
	Type string `json:"type"` // pvc | emptyDir | hostPath | configMap | secret
	// pvc
	Claim string `json:"claim"`
	// emptyDir
	SizeLimit string `json:"sizeLimit"` // 如 "1Gi"，空表示不限
	// hostPath
	Path         string `json:"path"`
	HostPathType string `json:"hostPathType"` // DirectoryOrCreate 等
	// configMap / secret
	RefName string `json:"refName"`
	// 挂载
	MountPath string `json:"mountPath"`
	SubPath   string `json:"subPath"`
	ReadOnly  bool   `json:"readOnly"`
}

// parseResourceList 把表单里可选的 cpu(millicores)/mem 字符串解析为 ResourceList。
// 任一项为空或非法则省略（不设置）。
func parseResourceList(cpu, mem string) corev1.ResourceList {
	out := corev1.ResourceList{}
	if cpu != "" {
		if v, e := strconv.Atoi(cpu); e == nil && v > 0 {
			out[corev1.ResourceCPU] = resource.MustParse(fmt.Sprintf("%dm", v))
		}
	}
	if mem != "" {
		if q, e := resource.ParseQuantity(mem); e == nil {
			out[corev1.ResourceMemory] = q
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// parseResourceRequirements 组装 Resources 字段：limit/req 各自可选，request 缺省时复用 limit。
func parseResourceRequirements(cpu, mem, cpuReq, memReq string) corev1.ResourceRequirements {
	req := corev1.ResourceRequirements{}
	limits := parseResourceList(cpu, mem)
	requests := parseResourceList(cpuReq, memReq)
	if len(requests) == 0 && len(limits) > 0 {
		requests = limits
	}
	if len(limits) > 0 {
		req.Limits = limits
	}
	if len(requests) > 0 {
		req.Requests = requests
	}
	return req
}

// sanitizePortName 把任意用户输入归一化为合法的 K8s 容器端口名（IANA_SVC_NAME）。
// 规则：仅小写字母/数字/连字符，且必须以字母或数字开头与结尾，长度 ≤ 63。
// 纯数字（如 "8080"）会被前缀 "p-" 修正为 "p-8080"，避免 K8s 报
// "must contain at least one letter or number" 之外的 "must start with an alphanumeric" 校验失败。
func sanitizePortName(in string, idx int) string {
	in = strings.ToLower(strings.TrimSpace(in))
	var b strings.Builder
	for _, r := range in {
		switch {
		case (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '-':
			b.WriteRune(r)
		case r > 127:
			// 丢弃非 ASCII 字符
		default:
			b.WriteRune('-')
		}
	}
	s := strings.Trim(b.String(), "-")
	if s == "" {
		return fmt.Sprintf("port-%d", idx)
	}
	// 必须以字母或数字开头（DNS-1123 label 约束）
	if s[0] >= '0' && s[0] <= '9' {
		s = "p-" + s
	}
	// 必须以字母或数字结尾
	s = strings.TrimRight(s, "-")
	if s == "" {
		s = fmt.Sprintf("port-%d", idx)
	}
	if len(s) > 63 {
		s = s[:63]
		s = strings.TrimRight(s, "-")
	}
	return s
}

// buildContainerPorts 把表单端口组装成 []corev1.ContainerPort。
// K8s 多端口必须命名；单端口可省略 name。用户填写的 name 一律归一化为合法 DNS-1123 名，
// 避免纯数字（如 "8080"）等非法值导致创建失败。
func buildContainerPorts(in []PortReq) []corev1.ContainerPort {
	if len(in) == 0 {
		return nil
	}
	multi := len(in) > 1
	out := make([]corev1.ContainerPort, 0, len(in))
	for i, p := range in {
		if p.ContainerPort <= 0 {
			continue
		}
		proto := p.Protocol
		if proto == "" {
			proto = "TCP"
		}
		name := p.Name
		if name == "" {
			// 单端口留空是合法的；多端口必须命名，自动补 port-<n>
			if multi {
				name = fmt.Sprintf("port-%d", i+1)
			}
		} else {
			name = sanitizePortName(name, i+1)
		}
		out = append(out, corev1.ContainerPort{
			Name:          name,
			ContainerPort: p.ContainerPort,
			Protocol:      corev1.Protocol(proto),
			HostPort:      p.HostPort,
		})
	}
	return out
}

// buildEnvVars 把表单 env 组装成 []corev1.EnvVar；空 name 跳过。
func buildEnvVars(in []EnvReq) []corev1.EnvVar {
	if len(in) == 0 {
		return nil
	}
	out := make([]corev1.EnvVar, 0, len(in))
	for _, e := range in {
		if e.Name == "" {
			continue
		}
		out = append(out, corev1.EnvVar{Name: e.Name, Value: e.Value})
	}
	if len(out) == 0 {
		return nil
	}
	return out
}

// buildProbe 把表单探针结构转为 *corev1.Probe；类型/必填端口或命令缺失时返回 nil（不下发）。
// 阈值类字段仅在 >0 时设置，避免用 0 覆盖 K8s 默认行为。
func buildProbe(p *ProbeReq) *corev1.Probe {
	if p == nil {
		return nil
	}
	probe := &corev1.Probe{}
	switch p.Type {
	case "http":
		if p.Port <= 0 {
			return nil
		}
		h := &corev1.HTTPGetAction{Path: p.Path, Port: intstr.FromInt(int(p.Port))}
		if sc := strings.ToUpper(p.Scheme); sc == "HTTPS" || sc == "HTTP" {
			h.Scheme = corev1.URIScheme(sc)
		}
		probe.ProbeHandler = corev1.ProbeHandler{HTTPGet: h}
	case "tcp":
		if p.Port <= 0 {
			return nil
		}
		probe.ProbeHandler = corev1.ProbeHandler{TCPSocket: &corev1.TCPSocketAction{Port: intstr.FromInt(int(p.Port))}}
	case "exec":
		if len(p.Command) == 0 {
			return nil
		}
		probe.ProbeHandler = corev1.ProbeHandler{Exec: &corev1.ExecAction{Command: p.Command}}
	default:
		return nil
	}
	if p.InitialDelaySeconds > 0 {
		probe.InitialDelaySeconds = p.InitialDelaySeconds
	}
	if p.PeriodSeconds > 0 {
		probe.PeriodSeconds = p.PeriodSeconds
	}
	if p.TimeoutSeconds > 0 {
		probe.TimeoutSeconds = p.TimeoutSeconds
	}
	if p.FailureThreshold > 0 {
		probe.FailureThreshold = p.FailureThreshold
	}
	if p.SuccessThreshold > 0 {
		probe.SuccessThreshold = p.SuccessThreshold
	}
	return probe
}

// buildVolumes 把表单卷列表转为 ([]corev1.Volume, []corev1.VolumeMount)。
// 同名/无挂载路径的行会被跳过；卷名缺失或类型必填字段缺失时跳过该卷。
func buildVolumes(in []VolumeReq) ([]corev1.Volume, []corev1.VolumeMount) {
	if len(in) == 0 {
		return nil, nil
	}
	var vols []corev1.Volume
	var mounts []corev1.VolumeMount
	for _, v := range in {
		if v.Name == "" {
			continue
		}
		vol := corev1.Volume{Name: v.Name}
		switch v.Type {
		case "pvc":
			if v.Claim == "" {
				continue
			}
			vol.PersistentVolumeClaim = &corev1.PersistentVolumeClaimVolumeSource{ClaimName: v.Claim}
		case "emptyDir":
			ed := &corev1.EmptyDirVolumeSource{}
			if v.SizeLimit != "" {
				if q, e := resource.ParseQuantity(v.SizeLimit); e == nil {
					ed.SizeLimit = &q
				}
			}
			vol.EmptyDir = ed
		case "hostPath":
			if v.Path == "" {
				continue
			}
			hp := &corev1.HostPathVolumeSource{Path: v.Path}
			if t := v.HostPathType; t != "" {
				ht := corev1.HostPathType(t)
				hp.Type = &ht
			}
			vol.HostPath = hp
		case "configMap":
			if v.RefName == "" {
				continue
			}
			vol.ConfigMap = &corev1.ConfigMapVolumeSource{LocalObjectReference: corev1.LocalObjectReference{Name: v.RefName}}
		case "secret":
			if v.RefName == "" {
				continue
			}
			vol.Secret = &corev1.SecretVolumeSource{SecretName: v.RefName}
		default:
			continue
		}
		vols = append(vols, vol)
		if v.MountPath == "" {
			continue
		}
		mounts = append(mounts, corev1.VolumeMount{
			Name:      v.Name,
			MountPath: v.MountPath,
			SubPath:   v.SubPath,
			ReadOnly:  v.ReadOnly,
		})
	}
	if len(vols) == 0 {
		return nil, nil
	}
	return vols, mounts
}

// CreateWorkload 在真实集群创建工作负载。仅当调用方已解析出合法 cluster id 时由 handler 调用，
// 这里不再做集群回退（未选集群应由 handler 直接 502）。
func (m *Manager) CreateWorkload(cid uint, req CreateWorkloadReq) error {
	cs, err := m.Clientset(cid)
	if err != nil {
		return err
	}
	ctx := context.TODO()

	// 统一标签：app 用于 selector/pod 匹配；managed-by 标注由本平台创建。
	labels := map[string]string{
		"app":                          req.Name,
		"app.kubernetes.io/name":       req.Name,
		"app.kubernetes.io/managed-by": "dunhelm",
	}
	selector := map[string]string{"app": req.Name}

	container := corev1.Container{
		Name:            req.Name,
		Image:           req.Image,
		Resources:       parseResourceRequirements(req.CPU, req.Mem, req.CPUReq, req.MemReq),
		Ports:           buildContainerPorts(req.Ports),
		Env:             buildEnvVars(req.Env),
		Command:         req.Command,
		Args:            req.Args,
		ImagePullPolicy: corev1.PullIfNotPresent,
		LivenessProbe:   buildProbe(req.LivenessProbe),
		ReadinessProbe:  buildProbe(req.ReadinessProbe),
		StartupProbe:    buildProbe(req.StartupProbe),
	}
	vols, mounts := buildVolumes(req.Volumes)
	container.VolumeMounts = mounts
	podSpec := corev1.PodSpec{Containers: []corev1.Container{container}}
	podSpec.Volumes = vols
	if req.PriorityClassName != "" {
		podSpec.PriorityClassName = req.PriorityClassName
	}
	if len(req.NodeSelector) > 0 {
		podSpec.NodeSelector = req.NodeSelector
	}
	template := corev1.PodTemplateSpec{
		ObjectMeta: metav1.ObjectMeta{Labels: labels},
		Spec:       podSpec,
	}
	meta := metav1.ObjectMeta{Name: req.Name, Namespace: req.Namespace, Labels: labels}

	switch strings.ToLower(req.Kind) {
	case "Deployment":
		rep := req.Replicas
		if rep <= 0 {
			rep = 1
		}
		dep := &appsv1.Deployment{
			ObjectMeta: meta,
			Spec: appsv1.DeploymentSpec{
				Replicas: &rep,
				Selector: &metav1.LabelSelector{MatchLabels: selector},
				Template: template,
			},
		}
		if _, e := cs.AppsV1().Deployments(req.Namespace).Create(ctx, dep, metav1.CreateOptions{}); e != nil {
			return wrapCreateErr("Deployment", e)
		}
		return nil

	case "StatefulSet":
		rep := req.Replicas
		if rep <= 0 {
			rep = 1
		}
		sts := &appsv1.StatefulSet{
			ObjectMeta: meta,
			Spec: appsv1.StatefulSetSpec{
				ServiceName: req.Name,
				Replicas:    &rep,
				Selector:    &metav1.LabelSelector{MatchLabels: selector},
				Template:    template,
			},
		}
		if _, e := cs.AppsV1().StatefulSets(req.Namespace).Create(ctx, sts, metav1.CreateOptions{}); e != nil {
			return wrapCreateErr("StatefulSet", e)
		}
		return nil

	case "DaemonSet":
		ds := &appsv1.DaemonSet{
			ObjectMeta: meta,
			Spec: appsv1.DaemonSetSpec{
				Selector: &metav1.LabelSelector{MatchLabels: selector},
				Template: template,
			},
		}
		if _, e := cs.AppsV1().DaemonSets(req.Namespace).Create(ctx, ds, metav1.CreateOptions{}); e != nil {
			return wrapCreateErr("DaemonSet", e)
		}
		return nil

	case "Job":
		// Job 的 Pod 不能用 RestartPolicy=Always（默认），改用 OnFailure 以匹配 backoffLimit 重试。
		podSpec.RestartPolicy = corev1.RestartPolicyOnFailure
		job := &batchv1.Job{
			ObjectMeta: meta,
			Spec: batchv1.JobSpec{
				BackoffLimit: int32Ptr(3),
				Template:     template,
			},
		}
		if _, e := cs.BatchV1().Jobs(req.Namespace).Create(ctx, job, metav1.CreateOptions{}); e != nil {
			return wrapCreateErr("Job", e)
		}
		return nil

	case "CronJob":
		if req.Schedule == "" {
			return fmt.Errorf("CronJob 需要填写调度周期(schedule)，例如 \"*/5 * * * *\"")
		}
		podSpec.RestartPolicy = corev1.RestartPolicyOnFailure
		cj := &batchv1.CronJob{
			ObjectMeta: meta,
			Spec: batchv1.CronJobSpec{
				Schedule: req.Schedule,
				JobTemplate: batchv1.JobTemplateSpec{
					ObjectMeta: metav1.ObjectMeta{Labels: labels},
					Spec: batchv1.JobSpec{
						Template: template,
					},
				},
			},
		}
		if _, e := cs.BatchV1().CronJobs(req.Namespace).Create(ctx, cj, metav1.CreateOptions{}); e != nil {
			return wrapCreateErr("CronJob", e)
		}
		return nil

	default:
		return fmt.Errorf("不支持的工作负载类型: %s（支持 Deployment/StatefulSet/DaemonSet/Job/CronJob）", req.Kind)
	}
}

// wrapCreateErr 把 K8s 创建错误转成中文友好提示；已存在同名资源时给明确提示。
func wrapCreateErr(kind string, e error) error {
	if apierr.IsAlreadyExists(e) {
		return fmt.Errorf("创建 %s 失败：命名空间内已存在同名 %s", kind, kind)
	}
	return fmt.Errorf("创建 %s 失败: %w", kind, e)
}