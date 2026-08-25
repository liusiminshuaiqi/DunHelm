package k8s

import (
	"context"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	apierr "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/util/intstr"
	"sigs.k8s.io/yaml"
)

// EditableSpec 是工作负载“可编辑项”的结构化表达，供前端编辑弹窗预填与回写。
// 与创建向导的字段一一对齐：副本数、镜像、资源(request/limit)、端口、环境变量、
// 启动命令/参数、三类探针、生命周期钩子(启动后/启动前)。
type EditableSpec struct {
	Kind     string           `json:"kind"`
	Replicas int32            `json:"replicas"` // -1 表示该类型无副本数概念（DaemonSet/Job/CronJob）
	Container EditableContainer `json:"container"`
}

// EditableContainer 单个主容器（containers[0]）的可编辑字段。
type EditableContainer struct {
	Name    string     `json:"name"`
	Image   string     `json:"image"`
	CPU     string     `json:"cpu"`     // 限制（毫核）
	Mem     string     `json:"mem"`     // 限制（K8s Quantity）
	CPUReq  string     `json:"cpuReq"`  // 请求
	MemReq  string     `json:"memReq"`  // 请求
	Ports   []PortReq  `json:"ports"`
	Command []string   `json:"command"`
	Args    []string   `json:"args"`
	Env     []EnvReq   `json:"env"`
	LivenessProbe  *ProbeReq       `json:"livenessProbe"`
	ReadinessProbe *ProbeReq       `json:"readinessProbe"`
	StartupProbe   *ProbeReq       `json:"startupProbe"`
	Lifecycle      *LifecycleSpec  `json:"lifecycle"`
}

// LifecycleSpec 生命周期钩子：启动后(PostStart)与启动前(PreStop)。
type LifecycleSpec struct {
	PostStart *LifecycleHandlerSpec `json:"postStart"`
	PreStop   *LifecycleHandlerSpec `json:"preStop"`
}

// LifecycleHandlerSpec 生命周期钩子处理函数：Exec 命令或 HTTP GET。
type LifecycleHandlerSpec struct {
	Type   string   `json:"type"` // exec | http
	Command []string `json:"command"`
	Path   string   `json:"path"`
	Port   int32    `json:"port"`
	Scheme string   `json:"scheme"` // HTTP | HTTPS
}

// GetWorkloadSpec 读取真实集群中工作负载的“可编辑项”快照（副本数 + 主容器字段）。
// 支持 deployment / statefulset / daemonset / job / cronjob。
func (m *Manager) GetWorkloadSpec(cid uint, ns, name, kind string) (*EditableSpec, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	spec := &EditableSpec{Kind: kind, Replicas: -1}
	var c *corev1.Container
	switch strings.ToLower(kind) {
	case "deployment":
		dep, e := cs.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return nil, wrapGetErr("Deployment", e)
		}
		if dep.Spec.Replicas != nil {
			spec.Replicas = *dep.Spec.Replicas
		}
		c = &dep.Spec.Template.Spec.Containers[0]
	case "statefulset":
		st, e := cs.AppsV1().StatefulSets(ns).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return nil, wrapGetErr("StatefulSet", e)
		}
		if st.Spec.Replicas != nil {
			spec.Replicas = *st.Spec.Replicas
		}
		c = &st.Spec.Template.Spec.Containers[0]
	case "daemonset":
		ds, e := cs.AppsV1().DaemonSets(ns).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return nil, wrapGetErr("DaemonSet", e)
		}
		c = &ds.Spec.Template.Spec.Containers[0]
	case "job":
		jb, e := cs.BatchV1().Jobs(ns).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return nil, wrapGetErr("Job", e)
		}
		c = &jb.Spec.Template.Spec.Containers[0]
	case "cronjob":
		cj, e := cs.BatchV1().CronJobs(ns).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return nil, wrapGetErr("CronJob", e)
		}
		c = &cj.Spec.JobTemplate.Spec.Template.Spec.Containers[0]
	default:
		return nil, fmt.Errorf("不支持的工作负载类型: %s", kind)
	}
	if c == nil {
		return nil, fmt.Errorf("工作负载 %s/%s 没有容器，无法编辑", ns, name)
	}
	spec.Container = readContainer(c)
	return spec, nil
}

// readContainer 把真实容器定义映射为 EditableContainer（请求/限制、端口、探针、生命周期等）。
func readContainer(c *corev1.Container) EditableContainer {
	ec := EditableContainer{
		Name:    c.Name,
		Image:   c.Image,
		Command: c.Command,
		Args:    c.Args,
	}
	if q, ok := c.Resources.Limits[corev1.ResourceCPU]; ok {
		ec.CPU = q.String()
	}
	if q, ok := c.Resources.Limits[corev1.ResourceMemory]; ok {
		ec.Mem = q.String()
	}
	if q, ok := c.Resources.Requests[corev1.ResourceCPU]; ok {
		ec.CPUReq = q.String()
	}
	if q, ok := c.Resources.Requests[corev1.ResourceMemory]; ok {
		ec.MemReq = q.String()
	}
	for _, p := range c.Ports {
		ec.Ports = append(ec.Ports, PortReq{
			Name:          p.Name,
			ContainerPort: p.ContainerPort,
			Protocol:      string(p.Protocol),
			HostPort:      p.HostPort,
		})
	}
	for _, e := range c.Env {
		ec.Env = append(ec.Env, EnvReq{Name: e.Name, Value: e.Value})
	}
	ec.LivenessProbe = readProbe(c.LivenessProbe)
	ec.ReadinessProbe = readProbe(c.ReadinessProbe)
	ec.StartupProbe = readProbe(c.StartupProbe)
	ec.Lifecycle = readLifecycle(c.Lifecycle)
	return ec
}

func readProbe(p *corev1.Probe) *ProbeReq {
	if p == nil {
		return nil
	}
	ps := &ProbeReq{
		InitialDelaySeconds: int32(p.InitialDelaySeconds),
		PeriodSeconds:       int32(p.PeriodSeconds),
		TimeoutSeconds:      int32(p.TimeoutSeconds),
		FailureThreshold:    int32(p.FailureThreshold),
		SuccessThreshold:    int32(p.SuccessThreshold),
	}
	switch {
	case p.HTTPGet != nil:
		ps.Type = "http"
		ps.Path = p.HTTPGet.Path
		ps.Port = int32(p.HTTPGet.Port.IntValue())
		ps.Scheme = string(p.HTTPGet.Scheme)
	case p.TCPSocket != nil:
		ps.Type = "tcp"
		ps.Port = int32(p.TCPSocket.Port.IntValue())
	case p.Exec != nil:
		ps.Type = "exec"
		ps.Command = p.Exec.Command
	}
	return ps
}

func readLifecycle(l *corev1.Lifecycle) *LifecycleSpec {
	if l == nil {
		return nil
	}
	out := &LifecycleSpec{}
	if l.PostStart != nil {
		out.PostStart = readLifecycleHandler(l.PostStart)
	}
	if l.PreStop != nil {
		out.PreStop = readLifecycleHandler(l.PreStop)
	}
	if out.PostStart == nil && out.PreStop == nil {
		return nil
	}
	return out
}

func readLifecycleHandler(h *corev1.LifecycleHandler) *LifecycleHandlerSpec {
	if h == nil {
		return nil
	}
	if h.Exec != nil {
		return &LifecycleHandlerSpec{Type: "exec", Command: h.Exec.Command}
	}
	if h.HTTPGet != nil {
		return &LifecycleHandlerSpec{Type: "http", Path: h.HTTPGet.Path, Port: int32(h.HTTPGet.Port.IntValue()), Scheme: string(h.HTTPGet.Scheme)}
	}
	return nil
}

// UpdateWorkloadSpec 把“可编辑项”写回真实集群：先 Get 实时对象，仅修改副本数与主容器字段，
// 其余字段(env/挂载卷/labels/annotations 等)原样保留，再 Update。这样不会丢字段。
// 工作负载控制器可能在 Get 与 Update 之间改动 resourceVersion（status 滚动等），
// 因此 Update 遇 409 Conflict 时最多重试 3 次（每次重新 Get 最新对象再改）。
func (m *Manager) UpdateWorkloadSpec(cid uint, ns, name, kind string, spec *EditableSpec) error {
	cs, err := m.Clientset(cid)
	if err != nil {
		return err
	}
	ctx := context.TODO()
	const maxRetry = 3
	switch strings.ToLower(kind) {
	case "deployment":
		var lastErr error
		for attempt := 0; attempt < maxRetry; attempt++ {
			dep, e := cs.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
			if e != nil {
				return wrapUpdErr("Deployment", e)
			}
			if spec.Replicas >= 0 {
				dep.Spec.Replicas = &spec.Replicas
			}
			applyContainerEdit(&dep.Spec.Template.Spec.Containers, spec.Container)
			if _, e := cs.AppsV1().Deployments(ns).Update(ctx, dep, metav1.UpdateOptions{}); e != nil {
				if !apierr.IsConflict(e) {
					return wrapUpdErr("Deployment", e)
				}
				lastErr = e
				continue
			}
			return nil
		}
		return wrapUpdErr("Deployment", lastErr)
	case "statefulset":
		var lastErr error
		for attempt := 0; attempt < maxRetry; attempt++ {
			st, e := cs.AppsV1().StatefulSets(ns).Get(ctx, name, metav1.GetOptions{})
			if e != nil {
				return wrapUpdErr("StatefulSet", e)
			}
			if spec.Replicas >= 0 {
				st.Spec.Replicas = &spec.Replicas
			}
			applyContainerEdit(&st.Spec.Template.Spec.Containers, spec.Container)
			if _, e := cs.AppsV1().StatefulSets(ns).Update(ctx, st, metav1.UpdateOptions{}); e != nil {
				if !apierr.IsConflict(e) {
					return wrapUpdErr("StatefulSet", e)
				}
				lastErr = e
				continue
			}
			return nil
		}
		return wrapUpdErr("StatefulSet", lastErr)
	case "daemonset":
		var lastErr error
		for attempt := 0; attempt < maxRetry; attempt++ {
			ds, e := cs.AppsV1().DaemonSets(ns).Get(ctx, name, metav1.GetOptions{})
			if e != nil {
				return wrapUpdErr("DaemonSet", e)
			}
			applyContainerEdit(&ds.Spec.Template.Spec.Containers, spec.Container)
			if _, e := cs.AppsV1().DaemonSets(ns).Update(ctx, ds, metav1.UpdateOptions{}); e != nil {
				if !apierr.IsConflict(e) {
					return wrapUpdErr("DaemonSet", e)
				}
				lastErr = e
				continue
			}
			return nil
		}
		return wrapUpdErr("DaemonSet", lastErr)
	case "job":
		var lastErr error
		for attempt := 0; attempt < maxRetry; attempt++ {
			jb, e := cs.BatchV1().Jobs(ns).Get(ctx, name, metav1.GetOptions{})
			if e != nil {
				return wrapUpdErr("Job", e)
			}
			applyContainerEdit(&jb.Spec.Template.Spec.Containers, spec.Container)
			if _, e := cs.BatchV1().Jobs(ns).Update(ctx, jb, metav1.UpdateOptions{}); e != nil {
				if !apierr.IsConflict(e) {
					return wrapUpdErr("Job", e)
				}
				lastErr = e
				continue
			}
			return nil
		}
		return wrapUpdErr("Job", lastErr)
	case "cronjob":
		var lastErr error
		for attempt := 0; attempt < maxRetry; attempt++ {
			cj, e := cs.BatchV1().CronJobs(ns).Get(ctx, name, metav1.GetOptions{})
			if e != nil {
				return wrapUpdErr("CronJob", e)
			}
			applyContainerEdit(&cj.Spec.JobTemplate.Spec.Template.Spec.Containers, spec.Container)
			if _, e := cs.BatchV1().CronJobs(ns).Update(ctx, cj, metav1.UpdateOptions{}); e != nil {
				if !apierr.IsConflict(e) {
					return wrapUpdErr("CronJob", e)
				}
				lastErr = e
				continue
			}
			return nil
		}
		return wrapUpdErr("CronJob", lastErr)
	default:
		return fmt.Errorf("不支持的工作负载类型: %s", kind)
	}
}

// applyContainerEdit 按容器名定位目标容器（默认 containers[0]），仅覆盖可编辑字段。
func applyContainerEdit(containers *[]corev1.Container, ec EditableContainer) {
	if containers == nil || len(*containers) == 0 {
		return
	}
	idx := 0
	for i, c := range *containers {
		if c.Name == ec.Name {
			idx = i
			break
		}
	}
	c := (*containers)[idx]
	if ec.Image != "" {
		c.Image = ec.Image
	}
	c.Resources = parseResourceRequirements(ec.CPU, ec.Mem, ec.CPUReq, ec.MemReq)
	c.Ports = buildContainerPorts(ec.Ports)
	c.Command = ec.Command
	c.Args = ec.Args
	c.Env = buildEnvVars(ec.Env)
	c.LivenessProbe = buildProbe(ec.LivenessProbe)
	c.ReadinessProbe = buildProbe(ec.ReadinessProbe)
	c.StartupProbe = buildProbe(ec.StartupProbe)
	c.Lifecycle = buildLifecycle(ec.Lifecycle)
	(*containers)[idx] = c
}

// buildLifecycle 把表单生命周期结构转为 *corev1.Lifecycle。
func buildLifecycle(l *LifecycleSpec) *corev1.Lifecycle {
	if l == nil {
		return nil
	}
	lc := &corev1.Lifecycle{}
	if l.PostStart != nil {
		lc.PostStart = buildLifecycleHandler(l.PostStart)
	}
	if l.PreStop != nil {
		lc.PreStop = buildLifecycleHandler(l.PreStop)
	}
	if lc.PostStart == nil && lc.PreStop == nil {
		return nil
	}
	return lc
}

func buildLifecycleHandler(h *LifecycleHandlerSpec) *corev1.LifecycleHandler {
	if h == nil {
		return nil
	}
	if h.Type == "http" {
		if h.Port <= 0 {
			return nil
		}
		port := int(h.Port)
		scheme := corev1.URISchemeHTTP
		if sc := corev1.URIScheme(h.Scheme); sc == corev1.URISchemeHTTPS || sc == corev1.URISchemeHTTP {
			scheme = sc
		}
		return &corev1.LifecycleHandler{
			HTTPGet: &corev1.HTTPGetAction{Path: h.Path, Port: intstr.FromInt(port), Scheme: scheme},
		}
	}
	// 默认 exec
	if len(h.Command) == 0 {
		return nil
	}
	return &corev1.LifecycleHandler{Exec: &corev1.ExecAction{Command: h.Command}}
}

// GetWorkloadYAML 返回真实集群中工作负载资源的完整 YAML 清单（含 apiVersion/kind/metadata/spec/status）。
// 用于详情页 YAML 标签页的完整展示。
func (m *Manager) GetWorkloadYAML(cid uint, ns, name, kind string) (string, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return "", err
	}
	ctx := context.TODO()
	var obj runtime.Object
	switch strings.ToLower(kind) {
	case "deployment":
		o, e := cs.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return "", wrapGetErr("Deployment", e)
		}
		obj = o
	case "statefulset":
		o, e := cs.AppsV1().StatefulSets(ns).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return "", wrapGetErr("StatefulSet", e)
		}
		obj = o
	case "daemonset":
		o, e := cs.AppsV1().DaemonSets(ns).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return "", wrapGetErr("DaemonSet", e)
		}
		obj = o
	case "job":
		o, e := cs.BatchV1().Jobs(ns).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return "", wrapGetErr("Job", e)
		}
		obj = o
	case "cronjob":
		o, e := cs.BatchV1().CronJobs(ns).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return "", wrapGetErr("CronJob", e)
		}
		obj = o
	default:
		return "", fmt.Errorf("不支持的工作负载类型: %s", kind)
	}
	b, e := yaml.Marshal(obj)
	if e != nil {
		return "", fmt.Errorf("序列化 YAML 失败: %w", e)
	}
	return string(b), nil
}

func wrapGetErr(kind string, e error) error {
	if apierr.IsNotFound(e) {
		return fmt.Errorf("获取 %s 失败：未找到该资源", kind)
	}
	return fmt.Errorf("获取 %s 失败: %w", kind, e)
}

func wrapUpdErr(kind string, e error) error {
	if apierr.IsNotFound(e) {
		return fmt.Errorf("更新 %s 失败：未找到该资源", kind)
	}
	if apierr.IsConflict(e) {
		return fmt.Errorf("更新 %s 失败：资源已被并发修改，请刷新后重试", kind)
	}
	return fmt.Errorf("更新 %s 失败: %w", kind, e)
}
