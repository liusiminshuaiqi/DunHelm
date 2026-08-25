package k8s

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"time"

	"kubehelm/server/internal/model"

	"github.com/robfig/cron/v3"
	corev1 "k8s.io/api/core/v1"
	apierr "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/remotecommand"
)

// ---------- 时间 / 资源工具 ----------

func ageString(t metav1.Time) string {
	if t.IsZero() {
		return "—"
	}
	d := time.Since(t.Time)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd", int(d.Hours()/24))
	}
}

func durationString(start, end *metav1.Time) string {
	if start == nil || start.IsZero() {
		return "—"
	}
	var e time.Time
	if end != nil && !end.IsZero() {
		e = end.Time
	} else {
		e = time.Now()
	}
	d := e.Sub(start.Time)
	switch {
	case d < time.Minute:
		return fmt.Sprintf("%ds", int(d.Seconds()))
	case d < time.Hour:
		return fmt.Sprintf("%dm%02ds", int(d.Minutes()), int(d.Seconds())%60)
	default:
		return fmt.Sprintf("%dh%02dm", int(d.Hours()), int(d.Minutes())%60)
	}
}

func podStatusString(p *corev1.Pod) string {
	switch p.Status.Phase {
	case corev1.PodRunning:
		ready := true
		for _, c := range p.Status.ContainerStatuses {
			if !c.Ready {
				ready = false
			}
		}
		if ready {
			return "ok"
		}
		return "updating"
	case corev1.PodFailed:
		return "err"
	case corev1.PodPending:
		return "pending"
	default:
		return "pending"
	}
}

// podAgg 单个工作负载下所有 Pod 的聚合
type podAgg struct {
	cpuReq   int64
	restarts int32
	statuses []string
}

// loadPodAggregate 列出全部 Pod，解析 ReplicaSet→Deployment 归属，
// 按"有效工作负载 UID"聚合 CPU 请求、重启次数与 Pod 状态点。
func loadPodAggregate(cs *kubernetes.Clientset) (map[string]*podAgg, error) {
	ctx := context.TODO()
	rsList, err := cs.AppsV1().ReplicaSets(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	rsToDeploy := map[string]string{}
	for i := range rsList.Items {
		rs := &rsList.Items[i]
		for _, o := range rs.OwnerReferences {
			if o.Kind == "Deployment" {
				rsToDeploy[string(rs.UID)] = string(o.UID)
			}
		}
	}
	pods, err := cs.CoreV1().Pods(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	idx := map[string]*podAgg{}
	for i := range pods.Items {
		p := &pods.Items[i]
		owner := ""
		for _, o := range p.OwnerReferences {
			owner = string(o.UID)
			break
		}
		if owner == "" {
			continue
		}
		if d, ok := rsToDeploy[owner]; ok {
			owner = d
		}
		a := idx[owner]
		if a == nil {
			a = &podAgg{}
			idx[owner] = a
		}
		for _, c := range p.Spec.Containers {
			if r := c.Resources.Requests.Cpu(); r != nil {
				a.cpuReq += r.MilliValue()
			}
		}
		for _, cs2 := range p.Status.ContainerStatuses {
			a.restarts += cs2.RestartCount
		}
		a.statuses = append(a.statuses, podStatusString(p))
	}
	return idx, nil
}

// countPodsPerNode 统计各节点上处于运行/调度中的 Pod 数量
func countPodsPerNode(cs *kubernetes.Clientset) (map[string]int, error) {
	pods, err := cs.CoreV1().Pods(metav1.NamespaceAll).List(context.TODO(), metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := map[string]int{}
	for i := range pods.Items {
		p := &pods.Items[i]
		if p.Spec.NodeName == "" {
			continue
		}
		if p.Status.Phase == corev1.PodRunning || p.Status.Phase == corev1.PodPending {
			out[p.Spec.NodeName]++
		}
	}
	return out, nil
}

// ---------- Nodes ----------

// Nodes 返回集群节点列表（实时查询真实集群）。
// 第二个返回值 metricsReady 表示集群是否部署了 metrics-server：未部署时 CPU/内存使用率会降级为 0，
// 前端据此向用户明确提示「未就绪」而非显示误导性的 0%。
func (m *Manager) Nodes(cid uint) ([]model.Node, bool, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, false, err
	}
	ctx := context.TODO()
	nodeList, err := cs.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, false, err
	}

	// 探测 metrics-server 是否可用：能成功列出 NodeMetrics 才认为就绪，并直接取真实使用率
	metricsReady := false
	usedCpu := map[string]int64{}
	usedMem := map[string]int64{}
	if mc, mErr := m.MetricsClient(cid); mErr == nil {
		if nm, e := mc.MetricsV1beta1().NodeMetricses().List(ctx, metav1.ListOptions{}); e == nil {
			metricsReady = true
			for _, n := range nm.Items {
				usedCpu[n.Name] = n.Usage.Cpu().MilliValue()
				usedMem[n.Name] = n.Usage.Memory().Value() / (1024 * 1024)
			}
		}
	}
	perNode, _ := countPodsPerNode(cs)

	out := make([]model.Node, 0, len(nodeList.Items))
	for i := range nodeList.Items {
		out = append(out, nodeToModel(&nodeList.Items[i], usedCpu[nodeList.Items[i].Name], usedMem[nodeList.Items[i].Name], perNode[nodeList.Items[i].Name]))
	}

	// 节点磁盘使用率（根磁盘 / 与数据盘 /data）来自 node-exporter；未安装则逐节点降级为未就绪
	names := make([]string, 0, len(out))
	for _, n := range out {
		names = append(names, n.Name)
	}
	if diskMap, _, dErr := m.CollectDisk(cid, names); dErr == nil {
		for i := range out {
			if d, ok := diskMap[out[i].Name]; ok {
				out[i].DiskRoot = d.Root
				out[i].Disk = d.Root // 兼容字段
				out[i].DiskData = d.Data
				out[i].DiskDataFound = d.DataFound
				out[i].DiskReady = d.Ready
			}
		}
	}
	return out, metricsReady, nil
}

func nodeToModel(n *corev1.Node, usedCpuMilli, usedMemMi int64, runningPods int) model.Node {
	role := "worker"
	for k := range n.Labels {
		if k == "node-role.kubernetes.io/control-plane" || k == "node-role.kubernetes.io/master" {
			role = "control-plane"
		}
	}
	status := "ok"
	for _, c := range n.Status.Conditions {
		if c.Type == corev1.NodeReady && c.Status != corev1.ConditionTrue {
			status = "err"
		}
	}
	cpuCapMilli := n.Status.Capacity.Cpu().MilliValue()
	memCapMi := n.Status.Capacity.Memory().Value() / (1024 * 1024)
	cpuRate, memRate := 0, 0
	if cpuCapMilli > 0 && usedCpuMilli > 0 {
		cpuRate = int(usedCpuMilli * 100 / cpuCapMilli)
	}
	if memCapMi > 0 && usedMemMi > 0 {
		memRate = int(usedMemMi * 100 / int64(memCapMi))
	}
	ip := ""
	for _, addr := range n.Status.Addresses {
		if addr.Type == corev1.NodeInternalIP {
			ip = addr.Address
		}
	}
	return model.Node{
		Name:     n.Name,
		Role:     role,
		Status:   status,
		Cpu:      cpuRate,
		Mem:      memRate,
		Disk:     0,
		Pods:     runningPods,
		PodTotal: int(n.Status.Capacity.Pods().Value()),
		Version:  n.Status.NodeInfo.KubeletVersion,
		IP:       ip,
		OS:       n.Status.NodeInfo.OSImage,
		Kubelet:  n.Status.NodeInfo.KubeletVersion,
		Age:      ageString(n.CreationTimestamp),
	}
}

// ---------- Namespaces ----------

func (m *Manager) Namespaces(cid uint) ([]model.Namespace, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	nsList, err := cs.CoreV1().Namespaces().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	pods, err := cs.CoreV1().Pods(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	type nsStat struct {
		pods int
		cpu  int64
		mem  int64
	}
	stat := map[string]*nsStat{}
	for i := range pods.Items {
		p := &pods.Items[i]
		s := stat[p.Namespace]
		if s == nil {
			s = &nsStat{}
			stat[p.Namespace] = s
		}
		s.pods++
		for _, c := range p.Spec.Containers {
			if r := c.Resources.Requests.Cpu(); r != nil {
				s.cpu += r.MilliValue()
			}
			if r := c.Resources.Requests.Memory(); r != nil {
				s.mem += r.Value() / (1024 * 1024)
			}
		}
	}
	out := make([]model.Namespace, 0, len(nsList.Items))
	for i := range nsList.Items {
		n := &nsList.Items[i]
		st := stat[n.Name]
		ns := model.Namespace{Name: n.Name}
		if st != nil {
			ns.Pods = st.pods
			ns.Cpu = int(st.cpu / 1000) // 核
			ns.Mem = int(st.mem)         // MiB
		}
		out = append(out, ns)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Pods > out[j].Pods })
	return out, nil
}

// ---------- Events ----------

func (m *Manager) Events(cid uint, limit int) ([]model.Event, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	evList, err := cs.CoreV1().Events(metav1.NamespaceAll).List(context.TODO(), metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	items := evList.Items
	sort.Slice(items, func(i, j int) bool {
		return lastEventTime(&items[i]).After(lastEventTime(&items[j]))
	})
	if limit > 0 && len(items) > limit {
		items = items[:limit]
	}
	out := make([]model.Event, 0, len(items))
	for i := range items {
		e := &items[i]
		out = append(out, model.Event{
			Time:   e.LastTimestamp.Format("15:04"),
			Type:   strings.ToLower(string(e.Type)),
			Reason: e.Reason,
			Obj:    fmt.Sprintf("%s/%s", e.Namespace, e.InvolvedObject.Name),
			Msg:    e.Message,
		})
	}
	return out, nil
}

func lastEventTime(e *corev1.Event) time.Time {
	if !e.LastTimestamp.IsZero() {
		return e.LastTimestamp.Time
	}
	return e.CreationTimestamp.Time
}

// ---------- Workloads ----------

func (m *Manager) Workloads(cid uint) ([]model.Workload, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	agg, err := loadPodAggregate(cs)
	if err != nil {
		return nil, err
	}
	out := make([]model.Workload, 0, 32)

	// workloadContainerPorts 收集一个工作负载模板里所有容器暴露的端口（按 port+protocol 去重），
	// 供前端「指定工作负载」时把容器端口自动同步进 Service 端口映射。
	workloadContainerPorts := func(containers []corev1.Container) []model.ContainerPort {
		seen := make(map[string]bool)
		out := make([]model.ContainerPort, 0)
		for i := range containers {
			for _, cp := range containers[i].Ports {
				proto := string(cp.Protocol)
				if proto == "" {
					proto = "TCP"
				}
				key := fmt.Sprintf("%d/%s", cp.ContainerPort, proto)
				if seen[key] {
					continue
				}
				seen[key] = true
				out = append(out, model.ContainerPort{Port: cp.ContainerPort, Protocol: proto})
			}
		}
		return out
	}

	appendWl := func(name, ns, kind, image string, desired, ready int32, uid string, created metav1.Time, podLabels map[string]string, containerPorts []model.ContainerPort) {
		a := agg[uid]
		status := "updating"
		switch {
		case desired == 0:
			status = "pending"
		case desired == ready:
			status = "ok"
		case ready == 0:
			status = "err"
		}
		wl := model.Workload{
			Name:          name,
			Namespace:     ns,
			Kind:          kind,
			Status:        status,
			Desired:       int(desired),
			Ready:         int(ready),
			Image:         image,
			Age:           ageString(created),
			Labels:        podLabels,
			ContainerPorts: containerPorts,
		}
		if a != nil {
			wl.Cpu = int(a.cpuReq)
			wl.Restarts = int(a.restarts)
			wl.Pods = a.statuses
		}
		out = append(out, wl)
	}

	if list, e := cs.AppsV1().Deployments(metav1.NamespaceAll).List(ctx, metav1.ListOptions{}); e == nil {
		for i := range list.Items {
			d := &list.Items[i]
			desired, ready := int32(0), int32(0)
			if d.Spec.Replicas != nil {
				desired = *d.Spec.Replicas
			}
			ready = d.Status.ReadyReplicas
			img := ""
			if len(d.Spec.Template.Spec.Containers) > 0 {
				img = d.Spec.Template.Spec.Containers[0].Image
			}
			appendWl(d.Name, d.Namespace, "deployment", img, desired, ready, string(d.UID), d.CreationTimestamp, d.Spec.Template.Labels, workloadContainerPorts(d.Spec.Template.Spec.Containers))
		}
	}
	if list, e := cs.AppsV1().StatefulSets(metav1.NamespaceAll).List(ctx, metav1.ListOptions{}); e == nil {
		for i := range list.Items {
			s := &list.Items[i]
			desired, ready := int32(0), int32(0)
			if s.Spec.Replicas != nil {
				desired = *s.Spec.Replicas
			}
			ready = s.Status.ReadyReplicas
			img := ""
			if len(s.Spec.Template.Spec.Containers) > 0 {
				img = s.Spec.Template.Spec.Containers[0].Image
			}
			appendWl(s.Name, s.Namespace, "statefulset", img, desired, ready, string(s.UID), s.CreationTimestamp, s.Spec.Template.Labels, workloadContainerPorts(s.Spec.Template.Spec.Containers))
		}
	}
	if list, e := cs.AppsV1().DaemonSets(metav1.NamespaceAll).List(ctx, metav1.ListOptions{}); e == nil {
		for i := range list.Items {
			ds := &list.Items[i]
			appendWl(ds.Name, ds.Namespace, "daemonset", ds.Spec.Template.Spec.Containers[0].Image, ds.Status.DesiredNumberScheduled, ds.Status.NumberReady, string(ds.UID), ds.CreationTimestamp, ds.Spec.Template.Labels, workloadContainerPorts(ds.Spec.Template.Spec.Containers))
		}
	}
	return out, nil
}

// ---------- Jobs / CronJobs ----------

func (m *Manager) Jobs(cid uint) ([]model.Job, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	out := make([]model.Job, 0, 16)

	if list, e := cs.BatchV1().Jobs(metav1.NamespaceAll).List(ctx, metav1.ListOptions{}); e == nil {
		for i := range list.Items {
			j := &list.Items[i]
			par := int32(0)
			if j.Spec.Parallelism != nil {
				par = *j.Spec.Parallelism
			}
			status := "running"
			if j.Status.Succeeded > 0 && j.Status.Succeeded >= j.Status.Active {
				status = "ok"
			}
			if j.Status.Failed > 0 {
				status = "err"
			}
			img := ""
			if len(j.Spec.Template.Spec.Containers) > 0 {
				img = j.Spec.Template.Spec.Containers[0].Image
			}
			out = append(out, model.Job{
				Name:       j.Name,
				Namespace:  j.Namespace,
				Kind:       "job",
				Status:     status,
				Completions: int(j.Status.Succeeded),
				Parallelism: int(par),
				Duration:   durationString(j.Status.StartTime, nil),
				Image:      img,
				Age:        ageString(j.CreationTimestamp),
			})
		}
	}

	if list, e := cs.BatchV1().CronJobs(metav1.NamespaceAll).List(ctx, metav1.ListOptions{}); e == nil {
		parser := cron.NewParser(cron.Minute | cron.Hour | cron.Dom | cron.Month | cron.Dow)
		for i := range list.Items {
			cj := &list.Items[i]
			par := int32(0)
			if cj.Spec.JobTemplate.Spec.Parallelism != nil {
				par = *cj.Spec.JobTemplate.Spec.Parallelism
			}
			status := "ok"
			if cj.Status.Active != nil && len(cj.Status.Active) > 0 {
				status = "running"
			}
			img := ""
			if len(cj.Spec.JobTemplate.Spec.Template.Spec.Containers) > 0 {
				img = cj.Spec.JobTemplate.Spec.Template.Spec.Containers[0].Image
			}
			var lastS, nextS *string
			if cj.Status.LastSuccessfulTime != nil {
				s := cj.Status.LastSuccessfulTime.Format("15:04")
				lastS = &s
			} else if cj.Status.LastScheduleTime != nil {
				s := cj.Status.LastScheduleTime.Format("15:04")
				lastS = &s
			}
			if sched, perr := parser.Parse(cj.Spec.Schedule); perr == nil {
				s := sched.Next(time.Now()).Format("01-02 15:04")
				nextS = &s
			}
			active := len(cj.Status.Active)
			out = append(out, model.Job{
				Name:         cj.Name,
				Namespace:    cj.Namespace,
				Kind:         "cronjob",
				Status:       status,
				Completions:  0,
				Parallelism:  int(par),
				Duration:     "—",
				Image:        img,
				Age:          ageString(cj.CreationTimestamp),
				Schedule:     &cj.Spec.Schedule,
				Active:       &active,
				LastSchedule: lastS,
				NextSchedule: nextS,
			})
		}
	}
	return out, nil
}

// ---------- 集群汇总（供 Overview 使用） ----------

type Summary struct {
	Nodes     int
	Pods      int
	CpuUsed   int // millicores
	CpuTotal  int // millicores
	MemUsed   int // MiB
	MemTotal  int // MiB
	Version   string
	HasMetric bool
}

func (m *Manager) Summary(cid uint) (*Summary, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	s := &Summary{}

	nodeList, err := cs.CoreV1().Nodes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	s.Nodes = len(nodeList.Items)
	for i := range nodeList.Items {
		n := &nodeList.Items[i]
		s.CpuTotal += int(n.Status.Capacity.Cpu().MilliValue())
		s.MemTotal += int(n.Status.Capacity.Memory().Value() / (1024 * 1024))
	}

	if mc, mErr := m.MetricsClient(cid); mErr == nil {
		if nm, e := mc.MetricsV1beta1().NodeMetricses().List(ctx, metav1.ListOptions{}); e == nil {
			s.HasMetric = true
			for _, n := range nm.Items {
				s.CpuUsed += int(n.Usage.Cpu().MilliValue())
				s.MemUsed += int(n.Usage.Memory().Value() / (1024 * 1024))
			}
		}
	}

	if pods, e := cs.CoreV1().Pods(metav1.NamespaceAll).List(ctx, metav1.ListOptions{}); e == nil {
		s.Pods = len(pods.Items)
	}

	if v, e := cs.Discovery().ServerVersion(); e == nil {
		s.Version = v.GitVersion
	}
	return s, nil
}

// ---------- Pod 级操作（列表 / 日志 / exec）----------

// ContainerInfo 单容器摘要
type ContainerInfo struct {
	Name  string `json:"name"`
	Image string `json:"image"`
	Ready bool   `json:"ready"`
}

// PodInfo 某工作负载下单个 Pod 的摘要
type PodInfo struct {
	Name       string          `json:"name"`
	Namespace  string          `json:"namespace"`
	Status     string          `json:"status"`
	Containers []ContainerInfo `json:"containers"`
	Restarts   int             `json:"restarts"`
	Node       string          `json:"node"`
	PodIP      string          `json:"podIP"`
	Age        string          `json:"age"`

	// 所属工作负载（Pod 直接 ownerReference 的 Kind/Name），用于节点详情中按服务归类
	OwnerKind string `json:"ownerKind"`
	OwnerName string `json:"ownerName"`

	// 以下字段用于滚动更新过程的可视化
	CreatedAt  string `json:"createdAt"`  // RFC3339，前端据此判断"刚创建"
	Ready      bool   `json:"ready"`      // 所有容器均 Ready
	Deleting   bool   `json:"deleting"`   // 正在终止（DeletionTimestamp 非空）
	Updated    bool   `json:"updated"`    // 属于当前最新版本（新 Pod）
	PodRevision string `json:"podRevision"` // 所属 ReplicaSet revision / StatefulSet 修订哈希
}

// RolloutStatus 工作负载的滚动更新进度快照
type RolloutStatus struct {
	Desired     int32  `json:"desired"`     // 期望副本数
	Ready       int32  `json:"ready"`       // 就绪副本数
	Updated     int32  `json:"updated"`     // 已更新到最新版本的副本数
	Available   int32  `json:"available"`   // 可用副本数
	Paused      bool   `json:"paused"`      // 是否已暂停（副本数缩容为 0）
	Progressing bool   `json:"progressing"` // 是否仍在滚动中（前端据此决定轮询频率）
	Message     string `json:"message"`     // 人类可读的进度描述
}

func podToModel(p *corev1.Pod) PodInfo {
	status := podStatusString(p)
	if p.Status.Reason != "" {
		status = strings.ToLower(p.Status.Reason)
	}
	containers := make([]ContainerInfo, 0, len(p.Spec.Containers))
	var restarts int32
	allReady := len(p.Spec.Containers) > 0
	for _, c := range p.Spec.Containers {
		ready := false
		for _, cs := range p.Status.ContainerStatuses {
			if cs.Name == c.Name {
				ready = cs.Ready
				restarts += cs.RestartCount
			}
		}
		if !ready {
			allReady = false
		}
		containers = append(containers, ContainerInfo{Name: c.Name, Image: c.Image, Ready: ready})
	}
	deleting := p.DeletionTimestamp != nil
	if deleting {
		status = "Terminating"
		allReady = false
	}
	ownerKind, ownerName := "", ""
	for _, o := range p.OwnerReferences {
		ownerKind = o.Kind
		ownerName = o.Name
		break
	}
	created := ""
	if !p.CreationTimestamp.IsZero() {
		created = p.CreationTimestamp.UTC().Format(time.RFC3339)
	}
	// pod-template-hash(Deployment) / controller-revision-hash(StatefulSet·DaemonSet)
	rev := p.Labels["pod-template-hash"]
	if rev == "" {
		rev = p.Labels["controller-revision-hash"]
	}
	return PodInfo{
		Name:        p.Name,
		Namespace:   p.Namespace,
		Status:      status,
		Containers:  containers,
		Restarts:    int(restarts),
		Node:        p.Spec.NodeName,
		PodIP:       p.Status.PodIP,
		Age:         ageString(p.CreationTimestamp),
		OwnerKind:   ownerKind,
		OwnerName:   ownerName,
		CreatedAt:   created,
		Ready:       allReady,
		Deleting:    deleting,
		PodRevision: rev,
	}
}

// PodsOnNode 返回调度到指定节点上的全部 Pod（用于节点详情查看该节点承载的服务）。
// 通过 fieldSelector spec.nodeName 精确过滤，比逐个 Pod 比对更高效。
func (m *Manager) PodsOnNode(cid uint, nodeName string) ([]PodInfo, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	pods, err := cs.CoreV1().Pods("").List(ctx, metav1.ListOptions{FieldSelector: "spec.nodeName=" + nodeName})
	if err != nil {
		return nil, err
	}
	out := make([]PodInfo, 0, len(pods.Items))
	for i := range pods.Items {
		out = append(out, podToModel(&pods.Items[i]))
	}
	// 按命名空间、名称排序，便于在节点详情中浏览
	sort.Slice(out, func(i, j int) bool {
		if out[i].Namespace != out[j].Namespace {
			return out[i].Namespace < out[j].Namespace
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// PodsForWorkload 返回指定工作负载下的 Pod 列表 + 滚动更新进度。
// 通过 ownerReferences 链回溯（Pod→ReplicaSet→Deployment / Pod→Job→CronJob / 直接 StatefulSet·DaemonSet），
// 比 label selector 更稳健，能正确处理同 selector 多版本场景。
//
// 同时标记每个 Pod 是否属于「当前最新版本」（Updated），前端据此把滚动更新期间的
// 新建 Pod / 旧版本 Pod / 终止中 Pod 区分展示，让用户看得见重启进度。
func (m *Manager) PodsForWorkload(cid uint, ns, name, kind string) ([]PodInfo, *RolloutStatus, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, nil, err
	}
	ctx := context.TODO()

	// 1) 目标工作负载的 UID（cronjob 下 Pod 的 owner 链顶端是 CronJob）+ 滚动状态
	var targetUID string
	var rollout *RolloutStatus
	// latestHash：最新版本的 pod-template-hash / controller-revision-hash
	latestHash := ""
	switch strings.ToLower(kind) {
	case "deployment":
		if d, e := cs.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{}); e == nil {
			targetUID = string(d.UID)
			desired := int32(1)
			if d.Spec.Replicas != nil {
				desired = *d.Spec.Replicas
			}
			rollout = &RolloutStatus{
				Desired:   desired,
				Ready:     d.Status.ReadyReplicas,
				Updated:   d.Status.UpdatedReplicas,
				Available: d.Status.AvailableReplicas,
				Paused:    desired == 0,
			}
		}
	case "statefulset":
		if s, e := cs.AppsV1().StatefulSets(ns).Get(ctx, name, metav1.GetOptions{}); e == nil {
			targetUID = string(s.UID)
			desired := int32(1)
			if s.Spec.Replicas != nil {
				desired = *s.Spec.Replicas
			}
			rollout = &RolloutStatus{
				Desired:   desired,
				Ready:     s.Status.ReadyReplicas,
				Updated:   s.Status.UpdatedReplicas,
				Available: s.Status.AvailableReplicas,
				Paused:    desired == 0,
			}
			latestHash = s.Status.UpdateRevision
		}
	case "daemonset":
		if d, e := cs.AppsV1().DaemonSets(ns).Get(ctx, name, metav1.GetOptions{}); e == nil {
			targetUID = string(d.UID)
			rollout = &RolloutStatus{
				Desired:   d.Status.DesiredNumberScheduled,
				Ready:     d.Status.NumberReady,
				Updated:   d.Status.UpdatedNumberScheduled,
				Available: d.Status.NumberAvailable,
			}
		}
	case "job":
		if j, e := cs.BatchV1().Jobs(ns).Get(ctx, name, metav1.GetOptions{}); e == nil {
			targetUID = string(j.UID)
		}
	case "cronjob":
		if cj, e := cs.BatchV1().CronJobs(ns).Get(ctx, name, metav1.GetOptions{}); e == nil {
			targetUID = string(cj.UID)
		}
	}
	if targetUID == "" {
		return nil, nil, fmt.Errorf("未找到工作负载 %s/%s (%s)", ns, name, kind)
	}

	// 2) 索引 ReplicaSet / Job 的 owner，用于回溯；同时找出 Deployment 的最新 RS
	rsOwner := map[string]string{}
	if rsList, e := cs.AppsV1().ReplicaSets(ns).List(ctx, metav1.ListOptions{}); e == nil {
		maxRev := int64(-1)
		for i := range rsList.Items {
			rs := &rsList.Items[i]
			ownedByTarget := false
			for _, o := range rs.OwnerReferences {
				if o.Kind == "Deployment" {
					rsOwner[string(rs.UID)] = string(o.UID)
					if string(o.UID) == targetUID {
						ownedByTarget = true
					}
				}
			}
			// Deployment 的「最新版本」= revision 注解最大的那个 ReplicaSet
			if kind == "deployment" && ownedByTarget {
				if rv, e2 := strconv.ParseInt(rs.Annotations["deployment.kubernetes.io/revision"], 10, 64); e2 == nil && rv > maxRev {
					maxRev = rv
					latestHash = rs.Labels["pod-template-hash"]
				}
			}
		}
	}
	// DaemonSet 无 UpdateRevision 字段，取 revision 最大的 ControllerRevision 名字作为最新版本标识
	if kind == "daemonset" {
		if revs, e := cs.AppsV1().ControllerRevisions(ns).List(ctx, metav1.ListOptions{}); e == nil {
			maxRev := int64(-1)
			for i := range revs.Items {
				cr := &revs.Items[i]
				for _, o := range cr.OwnerReferences {
					if o.Kind == "DaemonSet" && string(o.UID) == targetUID && cr.Revision > maxRev {
						maxRev = cr.Revision
						latestHash = cr.Labels["controller-revision-hash"]
						if latestHash == "" {
							// 回退：ControllerRevision 名字形如 <ds-name>-<hash>
							if idx := strings.LastIndex(cr.Name, "-"); idx >= 0 {
								latestHash = cr.Name[idx+1:]
							}
						}
					}
				}
			}
		}
	}
	// StatefulSet 的 UpdateRevision 形如 <sts-name>-<hash>，而 Pod 标签只存 hash 部分之外的完整值，
	// 两者实际一致（controller-revision-hash 存的就是完整 revision 名），无需截断。

	jobOwner := map[string]string{}
	if jobList, e := cs.BatchV1().Jobs(ns).List(ctx, metav1.ListOptions{}); e == nil {
		for i := range jobList.Items {
			j := &jobList.Items[i]
			for _, o := range j.OwnerReferences {
				if o.Kind == "CronJob" {
					jobOwner[string(j.UID)] = string(o.UID)
				}
			}
		}
	}

	pods, err := cs.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, rollout, err
	}
	out := make([]PodInfo, 0, 4)
	for i := range pods.Items {
		p := &pods.Items[i]
		owner := ""
		for _, o := range p.OwnerReferences {
			owner = string(o.UID)
			break
		}
		top := owner
		if d, ok := rsOwner[top]; ok {
			top = d
		}
		if c, ok := jobOwner[top]; ok {
			top = c
		}
		if top != targetUID {
			continue
		}
		pi := podToModel(p)
		// 没有版本标识（如裸 Pod）时视为最新，避免全部误标"旧版本"
		pi.Updated = latestHash == "" || pi.PodRevision == "" || pi.PodRevision == latestHash
		out = append(out, pi)
	}

	// 新建的排前面，方便观察滚动更新
	sort.Slice(out, func(i, j int) bool {
		if out[i].Deleting != out[j].Deleting {
			return !out[i].Deleting // 终止中的排最后
		}
		if out[i].Updated != out[j].Updated {
			return out[i].Updated // 新版本排前面
		}
		return out[i].CreatedAt > out[j].CreatedAt
	})

	if rollout != nil {
		fillRolloutMessage(rollout, out)
	}
	return out, rollout, nil
}

// fillRolloutMessage 依据副本数与 Pod 实况推导「是否仍在滚动」及进度文案。
func fillRolloutMessage(r *RolloutStatus, pods []PodInfo) {
	terminating := 0
	notReady := 0
	for _, p := range pods {
		if p.Deleting {
			terminating++
			continue
		}
		if !p.Ready {
			notReady++
		}
	}
	switch {
	case r.Paused:
		r.Progressing = false
		r.Message = "已暂停（副本数为 0）"
	case r.Updated < r.Desired:
		r.Progressing = true
		r.Message = fmt.Sprintf("滚动更新中：%d/%d 个副本已更新", r.Updated, r.Desired)
	case r.Ready < r.Desired || notReady > 0:
		r.Progressing = true
		r.Message = fmt.Sprintf("等待副本就绪：%d/%d 就绪", r.Ready, r.Desired)
	case terminating > 0:
		r.Progressing = true
		r.Message = fmt.Sprintf("正在回收 %d 个旧 Pod", terminating)
	default:
		r.Progressing = false
		r.Message = fmt.Sprintf("运行正常：%d/%d 副本可用", r.Available, r.Desired)
	}
}

// PodLogs 返回 Pod 日志的流式读取器（支持 tail 限行与 follow 实时追加）。
func (m *Manager) PodLogs(cid uint, ns, pod, container string, tail int64, follow bool) (io.ReadCloser, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	opts := &corev1.PodLogOptions{Container: container, Follow: follow}
	if tail > 0 {
		opts.TailLines = &tail
	}
	req := cs.CoreV1().Pods(ns).GetLogs(pod, opts)
	return req.Stream(context.TODO())
}

// PodExec 构建到指定 Pod 容器的 exec 执行器（SPDY），供 WebSocket 桥接使用。
func (m *Manager) PodExec(cid uint, ns, pod, container, command string) (remotecommand.Executor, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	restCfg, err := m.RestConfig(cid)
	if err != nil {
		return nil, err
	}
	cmd := strings.Fields(command)
	if len(cmd) == 0 {
		cmd = []string{"/bin/sh"}
	}
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	paramCodec := runtime.NewParameterCodec(scheme)
	req := cs.CoreV1().RESTClient().
		Post().
		Resource("pods").
		Name(pod).
		Namespace(ns).
		SubResource("exec")
	req.VersionedParams(&corev1.PodExecOptions{
		Container: container,
		Command:   cmd,
		Stdin:     true,
		Stdout:    true,
		Stderr:    true,
		TTY:       true,
	}, paramCodec)
	return remotecommand.NewSPDYExecutor(restCfg, "POST", req.URL())
}

// ---------- 工作负载写操作（暂停/恢复/重启/升级/回滚）----------

// RevisionInfo 单条发布历史（rollout history）。
type RevisionInfo struct {
	Revision int64  `json:"revision"`
	Image    string `json:"image"` // 首个容器镜像，便于辨认
	Age      string `json:"age"`
	Current  bool   `json:"current"` // 是否为当前生效版本
}

// revisionItem 是发布历史的统一内部结构：Deployment 来自 ReplicaSet，
// StatefulSet/DaemonSet 来自 ControllerRevision。
type revisionItem struct {
	rev       int64
	containers []corev1.Container
	ts        metav1.Time
}

// listRevisions 收集工作负载的发布历史。
// ⚠️ 关键：Kubernetes 中 Deployment 的发布历史是 ReplicaSet（带
// deployment.kubernetes.io/revision 注解），Deployment 并不创建 ControllerRevision；
// 只有 StatefulSet / DaemonSet 才使用 ControllerRevision。两者必须分开取。
func (m *Manager) listRevisions(cs *kubernetes.Clientset, ns, name, kind string) ([]revisionItem, error) {
	ctx := context.TODO()
	if kind == "deployment" {
		rss, err := cs.AppsV1().ReplicaSets(ns).List(ctx, metav1.ListOptions{})
		if err != nil {
			return nil, err
		}
		items := make([]revisionItem, 0, 4)
		for i := range rss.Items {
			rs := &rss.Items[i]
			matched := false
			for _, o := range rs.OwnerReferences {
				if o.Kind == "Deployment" && o.Name == name {
					matched = true
					break
				}
			}
			if !matched {
				continue
			}
			rev, e := strconv.ParseInt(rs.Annotations["deployment.kubernetes.io/revision"], 10, 64)
			if e != nil {
				continue
			}
			items = append(items, revisionItem{rev: rev, containers: rs.Spec.Template.Spec.Containers, ts: rs.CreationTimestamp})
		}
		return items, nil
	}
	// statefulset / daemonset：发布历史存于 ControllerRevision
	revs, err := cs.AppsV1().ControllerRevisions(ns).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	items := make([]revisionItem, 0, 4)
	for i := range revs.Items {
		cr := &revs.Items[i]
		matched := false
		for _, o := range cr.OwnerReferences {
			if (kind == "statefulset" && o.Kind == "StatefulSet" && o.Name == name) ||
				(kind == "daemonset" && o.Kind == "DaemonSet" && o.Name == name) {
				matched = true
				break
			}
		}
		if !matched {
			continue
		}
		var tmpl corev1.PodTemplateSpec
		if e := json.Unmarshal(cr.Data.Raw, &tmpl); e != nil {
			continue
		}
		items = append(items, revisionItem{rev: cr.Revision, containers: tmpl.Spec.Containers, ts: cr.CreationTimestamp})
	}
	return items, nil
}

// WorkloadRevisions 返回工作负载的发布历史（以及 Deployment 的暂停状态）。
// 供前端“回滚”弹窗选择版本，以及“暂停/恢复”按钮文案判断。
func (m *Manager) WorkloadRevisions(cid uint, ns, name, kind string) ([]RevisionInfo, bool, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, false, err
	}

	// 暂停状态 = 期望副本数为 0（与 ActionWorkload 的 pause 语义一致）
	paused := false
	if kind == "deployment" || kind == "statefulset" {
		if r, e := m.currentReplicas(cs, ns, name, kind); e == nil {
			paused = r == 0
		}
	}

	items, err := m.listRevisions(cs, ns, name, kind)
	if err != nil {
		return nil, paused, err
	}
	// 按 revision 降序
	sort.Slice(items, func(i, j int) bool { return items[i].rev > items[j].rev })

	out := make([]RevisionInfo, 0, len(items))
	for i, it := range items {
		img := ""
		if len(it.containers) > 0 {
			img = it.containers[0].Image
		}
		out = append(out, RevisionInfo{
			Revision: it.rev,
			Image:    img,
			Age:      ageString(it.ts),
			Current:  i == 0, // 最新一条为当前版本
		})
	}
	return out, paused, nil
}

// replicasBeforePauseAnno 记录「暂停（缩容到 0）」之前的副本数，供恢复时还原。
const replicasBeforePauseAnno = "kubehelm.io/replicas-before-pause"

// currentReplicas 读取工作负载当前的期望副本数（DaemonSet 无此概念）。
func (m *Manager) currentReplicas(cs *kubernetes.Clientset, ns, name, kind string) (int32, error) {
	ctx := context.TODO()
	switch strings.ToLower(kind) {
	case "deployment":
		d, e := cs.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return 0, e
		}
		if d.Spec.Replicas == nil {
			return 1, nil
		}
		return *d.Spec.Replicas, nil
	case "statefulset":
		s, e := cs.AppsV1().StatefulSets(ns).Get(ctx, name, metav1.GetOptions{})
		if e != nil {
			return 0, e
		}
		if s.Spec.Replicas == nil {
			return 1, nil
		}
		return *s.Spec.Replicas, nil
	}
	return 0, fmt.Errorf("不支持的工作负载类型: %s", kind)
}

// replicasBeforePause 读取缩容前副本数注解；不存在或非法时返回 0。
func (m *Manager) replicasBeforePause(cs *kubernetes.Clientset, ns, name, kind string) int32 {
	ctx := context.TODO()
	var anno map[string]string
	switch strings.ToLower(kind) {
	case "deployment":
		if d, e := cs.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{}); e == nil {
			anno = d.Annotations
		}
	case "statefulset":
		if s, e := cs.AppsV1().StatefulSets(ns).Get(ctx, name, metav1.GetOptions{}); e == nil {
			anno = s.Annotations
		}
	}
	if v, ok := anno[replicasBeforePauseAnno]; ok {
		if n, e := strconv.Atoi(v); e == nil && n > 0 {
			return int32(n)
		}
	}
	return 0
}

// ActionWorkload 对工作负载执行写操作。action ∈ {pause,resume,restart,upgrade,rollback}。
// payload 可携带：upgrade→containers([]map{name,image})；rollback→revision(int64，0=上一个)。
//
// 注意 pause/resume 的语义是「缩容到 0 / 还原副本数」，不是 Deployment 的 spec.paused
// （后者只冻结滚动更新、Pod 仍在运行，不符合"暂停服务"的直觉）。
func (m *Manager) ActionWorkload(cid uint, ns, name, kind, action string, payload map[string]any) error {
	cs, err := m.Clientset(cid)
	if err != nil {
		return err
	}
	ctx := context.TODO()

	applyPatch := func(patchBytes []byte) error {
		switch strings.ToLower(kind) {
		case "deployment":
			_, e := cs.AppsV1().Deployments(ns).Patch(ctx, name, types.StrategicMergePatchType, patchBytes, metav1.PatchOptions{})
			return e
		case "statefulset":
			_, e := cs.AppsV1().StatefulSets(ns).Patch(ctx, name, types.StrategicMergePatchType, patchBytes, metav1.PatchOptions{})
			return e
		case "daemonset":
			_, e := cs.AppsV1().DaemonSets(ns).Patch(ctx, name, types.StrategicMergePatchType, patchBytes, metav1.PatchOptions{})
			return e
		}
		return fmt.Errorf("不支持的工作负载类型: %s（仅支持 deployment/statefulset/daemonset）", kind)
	}

	switch action {
	case "pause", "resume":
		// 语义：暂停 = 缩容到 0 副本（服务真正停掉）；恢复 = 还原缩容前的副本数。
		// 缩容前的副本数记在注解 replicasBeforePauseAnno 上，恢复时读取；
		// 注解缺失（例如手工 scale 到 0 后再点恢复）则回落到 1 副本。
		if kind == "daemonset" {
			return fmt.Errorf("DaemonSet 没有副本数概念，不支持暂停/恢复")
		}
		if kind != "deployment" && kind != "statefulset" {
			return fmt.Errorf("\"%s\" 仅适用于 Deployment / StatefulSet", action)
		}
		cur, err := m.currentReplicas(cs, ns, name, kind)
		if err != nil {
			return err
		}
		if action == "pause" {
			if cur == 0 {
				return fmt.Errorf("%s 当前副本数已为 0，无需暂停", name)
			}
			b, _ := json.Marshal(map[string]any{
				"metadata": map[string]any{
					"annotations": map[string]any{replicasBeforePauseAnno: strconv.Itoa(int(cur))},
				},
				"spec": map[string]any{"replicas": 0},
			})
			return applyPatch(b)
		}
		// resume
		target := m.replicasBeforePause(cs, ns, name, kind)
		if target <= 0 {
			target = 1
		}
		b, _ := json.Marshal(map[string]any{
			"metadata": map[string]any{
				// 置 null 即从对象上移除该注解，避免残留误导下次恢复
				"annotations": map[string]any{replicasBeforePauseAnno: nil},
			},
			"spec": map[string]any{"replicas": target},
		})
		return applyPatch(b)

	case "restart":
		b, _ := json.Marshal(map[string]any{
			"spec": map[string]any{
				"template": map[string]any{
					"metadata": map[string]any{
						"annotations": map[string]any{
							"kubectl.kubernetes.io/restartedAt": time.Now().Format(time.RFC3339),
						},
					},
				},
			},
		})
		return applyPatch(b)

	case "upgrade":
		raw, ok := payload["containers"]
		if !ok {
			return fmt.Errorf("upgrade 操作缺少 containers 参数")
		}
		containers, ok := raw.([]any)
		if !ok || len(containers) == 0 {
			return fmt.Errorf("upgrade 操作 containers 为空")
		}
		patchContainers := make([]map[string]any, 0, len(containers))
		for _, c := range containers {
			cm, ok := c.(map[string]any)
			if !ok {
				continue
			}
			nm, _ := cm["name"].(string)
			img, _ := cm["image"].(string)
			if nm == "" || img == "" {
				continue
			}
			patchContainers = append(patchContainers, map[string]any{"name": nm, "image": img})
		}
		if len(patchContainers) == 0 {
			return fmt.Errorf("upgrade 操作没有有效的容器镜像")
		}
		b, _ := json.Marshal(map[string]any{
			"spec": map[string]any{
				"template": map[string]any{
					"spec": map[string]any{"containers": patchContainers},
				},
			},
		})
		return applyPatch(b)

	case "rollback":
		target := int64(0)
		if r, ok := payload["revision"]; ok {
			switch v := r.(type) {
			case float64:
				target = int64(v)
			case int64:
				target = v
			}
		}
		oldContainers, err := m.rollbackContainers(cs, ns, name, kind, target)
		if err != nil {
			return err
		}
		b, _ := json.Marshal(map[string]any{
			"spec": map[string]any{
				"template": map[string]any{
					"spec": map[string]any{"containers": oldContainers},
				},
			},
		})
		return applyPatch(b)

	case "delete":
		// 删除工作负载（含 Deployment/StatefulSet/DaemonSet/Job/CronJob）。
		// 前台级联删除，确保关联 Pod/ReplicaSet 一并清理。
		delOpt := metav1.DeleteOptions{PropagationPolicy: func() *metav1.DeletionPropagation {
			p := metav1.DeletePropagationForeground
			return &p
		}()}
		switch strings.ToLower(kind) {
		case "deployment":
			return wrapDelErr("Deployment", cs.AppsV1().Deployments(ns).Delete(ctx, name, delOpt))
		case "statefulset":
			return wrapDelErr("StatefulSet", cs.AppsV1().StatefulSets(ns).Delete(ctx, name, delOpt))
		case "daemonset":
			return wrapDelErr("DaemonSet", cs.AppsV1().DaemonSets(ns).Delete(ctx, name, delOpt))
		case "job":
			return wrapDelErr("Job", cs.BatchV1().Jobs(ns).Delete(ctx, name, delOpt))
		case "cronjob":
			return wrapDelErr("CronJob", cs.BatchV1().CronJobs(ns).Delete(ctx, name, delOpt))
		}
		return fmt.Errorf("不支持的工作负载类型: %s（仅支持 deployment/statefulset/daemonset/job/cronjob）", kind)
	}
	return fmt.Errorf("不支持的操作: %s", action)
}

func wrapDelErr(kind string, e error) error {
	if e == nil {
		return nil
	}
	if apierr.IsNotFound(e) {
		return fmt.Errorf("删除 %s 失败：未找到该资源", kind)
	}
	return fmt.Errorf("删除 %s 失败: %w", kind, e)
}

// rollbackContainers 找到目标 revision 对应的容器定义（用于回滚镜像/配置）。
// revision=0 表示回滚到“上一个”版本（最新版本的前一条）；否则回滚到指定 revision。
func (m *Manager) rollbackContainers(cs *kubernetes.Clientset, ns, name, kind string, target int64) ([]map[string]any, error) {
	items, err := m.listRevisions(cs, ns, name, kind)
	if err != nil {
		return nil, err
	}
	if len(items) == 0 {
		return nil, fmt.Errorf("未找到工作负载 %s/%s 的发布历史", ns, name)
	}
	sort.Slice(items, func(i, j int) bool { return items[i].rev > items[j].rev })

	// target=0 → 上一个版本（最新版本之前的那条）；若只有一条历史则无法回滚
	var chosen *revisionItem
	if target == 0 {
		if len(items) < 2 {
			return nil, fmt.Errorf("只有一个发布版本，无法回滚（请先执行至少一次升级）")
		}
		chosen = &items[1]
	} else {
		for i := range items {
			if items[i].rev == target {
				chosen = &items[i]
				break
			}
		}
	}
	if chosen == nil {
		return nil, fmt.Errorf("未找到 revision=%d 的发布历史", target)
	}
	out := make([]map[string]any, 0, len(chosen.containers))
	for _, c := range chosen.containers {
		out = append(out, map[string]any{"name": c.Name, "image": c.Image})
	}
	return out, nil
}
