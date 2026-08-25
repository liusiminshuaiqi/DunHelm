package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"mime/multipart"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"kubehelm/server/internal/audit"
	"kubehelm/server/internal/ci"
	"kubehelm/server/internal/crypto"
	"kubehelm/server/internal/k8s"
	"kubehelm/server/internal/middleware"
	"kubehelm/server/internal/model"
	"kubehelm/server/internal/repository"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
	"gopkg.in/yaml.v3"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/tools/remotecommand"
)

// Handler 持有数据访问层与多集群 K8s 客户端管理
type Handler struct {
	Store *repository.Store
	K8s   *k8s.Manager
	CI    *ci.Engine
	// regCache 镜像仓库读路径的短期 TTL 缓存（项目/仓库/制品列表）。项目增删 / 制品 push 后会 invalidate。
	// 目的：避免每次点开「从镜像仓库选择」弹窗都重新打真实 Harbor（DNS + TCP + TLS 握手 + 真实接口调用，几秒延迟）。
	regCache *registryCache
}

func New(s *repository.Store, k *k8s.Manager, c *ci.Engine) *Handler {
	return &Handler{Store: s, K8s: k, CI: c, regCache: newRegistryCache(30 * time.Second)}
}

// clusterID 从 ?cluster= 取当前集群；优先从 ctx 取（被 RequireClusterAccess 注入），
// 否则取 DB 中第一个集群。无可用集群时返回错误（按"直接返回错误"策略）。
func (h *Handler) clusterID(c *gin.Context) (uint, error) {
	return h.clusterIDWith(c, "")
}

// clusterIDWith 在 ?cluster= 之外额外接受一个显式集群 id（通常来自 POST 请求体），
// 优先级：ctx（RequireClusterAccess 注入）> query > body > DB 第一个集群。
//
// 背景：写操作（/workload-action）以 JSON body 传参，若只读 query 会静默回退到
// "DB 第一个集群"，导致明明选的是 dev 集群却把请求打到 prod 集群并报
// "尚未配置 KubeConfig"。此处统一兜住两种传参方式。
func (h *Handler) clusterIDWith(c *gin.Context, explicit string) (uint, error) {
	// 优先 ctx（RequireClusterAccess 已经做过权限校验）
	if v, ok := c.Get("clusterID"); ok {
		if id, ok := v.(uint); ok && id > 0 {
			return id, nil
		}
	}
	for _, id := range []string{c.Query("cluster"), explicit} {
		if id == "" {
			continue
		}
		if v, err := strconv.ParseUint(id, 10, 64); err == nil && v > 0 {
			return uint(v), nil
		}
	}
	var first model.Cluster
	if err := h.Store.DB.Order("id").First(&first).Error; err == nil {
		return first.ID, nil
	}
	return 0, fmt.Errorf("无可用集群，请先在「集群管理」中注册 KubeConfig")
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// clusterIDOrFallback 返回 (cluster id, true) 若 query 显式指定了 ?cluster= 且解析成功；
// 否则返回 (0, false)。用于"显式选真实集群才走 K8s，否则回退到 DB mock"的双路径判断。
// 背景：clusterID() 会自动 fallback 到 DB 第一个集群，导致 StorageClasses 等接口
// 即便未传 ?cluster= 也会尝试连真实集群（可能 no-kubeconfig 报错）；这里用此函数区分意图。
func (h *Handler) clusterIDOrFallback(c *gin.Context) (uint, bool) {
	// 优先从 ctx 取（RequireClusterAccess 注入）
	if v, ok := c.Get("clusterID"); ok {
		if id, ok := v.(uint); ok && id > 0 {
			return id, true
		}
	}
	raw := c.Query("cluster")
	if raw == "" {
		return 0, false
	}
	v, err := strconv.ParseUint(raw, 10, 64)
	if err != nil || v == 0 {
		return 0, false
	}
	return uint(v), true
}

// genTrend 生成 24h 资源趋势（与前端原型算法一致）
func genTrend() []map[string]interface{} {
	out := make([]map[string]interface{}, 0, 24)
	for h := 0; h < 24; h++ {
		base := 46 + math.Sin((float64(h)/24)*math.Pi*2)*16
		noise := (math.Sin(float64(h)*1.7) + math.Cos(float64(h)*0.9)) * 4
		cpu := int(math.Max(18, math.Min(92, math.Round(base+noise))))
		mem := int(math.Max(30, math.Min(88, math.Round(base*0.92+noise*0.6+8))))
		out = append(out, map[string]interface{}{
			"h":   fmt.Sprintf("%02d:00", h),
			"cpu": cpu,
			"mem": mem,
		})
	}
	return out
}

// Overview 集群总览聚合（核心只读：实时查询真实集群）
func (h *Handler) Overview(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	sum, err := h.K8s.Summary(cid)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	ns, err := h.K8s.Namespaces(cid)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	nodes, _, err := h.K8s.Nodes(cid)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	events, err := h.K8s.Events(cid, 10)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}

	// 集群注册信息（name/provider/region）来自 DB，其余实时汇总
	var cl model.Cluster
	h.Store.DB.First(&cl, cid)
	cluster := gin.H{
		"id":        cl.ID,
		"name":      cl.Name,
		"provider":  cl.Provider,
		"region":    cl.Region,
		"version":   firstNonEmpty(sum.Version, cl.Version),
		"nodes":     sum.Nodes,
		"pods":      sum.Pods,
		"cpuUsed":   sum.CpuUsed,
		"cpuTotal":  sum.CpuTotal,
		"memUsed":   sum.MemUsed,
		"memTotal":  sum.MemTotal,
		"connected": true,
	}
	c.JSON(http.StatusOK, gin.H{
		"cluster":    cluster,
		"trend":      genTrend(),
		"namespaces": ns,
		"nodes":      nodes,
		"events":     events,
	})
}

// Namespaces 命名空间列表（供创建类弹窗选择，避免用户手填）
func (h *Handler) Namespaces(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	ns, err := h.K8s.Namespaces(cid)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, ns)
}

// Nodes 节点列表 + KPI（核心只读：实时查询真实集群）
func (h *Handler) Nodes(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	nodes, metricsReady, err := h.K8s.Nodes(cid)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	total := len(nodes)
	ready, cpuSum, memSum := 0, 0, 0
	for _, n := range nodes {
		if n.Status == "ok" {
			ready++
		}
		cpuSum += n.Cpu
		memSum += n.Mem
	}
	cpuRate, memRate := 0, 0
	if total > 0 {
		cpuRate = cpuSum / total
		memRate = memSum / total
	}
	diskReady := false
	for _, n := range nodes {
		if n.DiskReady {
			diskReady = true
			break
		}
	}
	c.JSON(http.StatusOK, gin.H{
		"kpi":  gin.H{"total": total, "ready": ready, "cpuRate": cpuRate, "memRate": memRate, "metricsReady": metricsReady, "diskReady": diskReady},
		"nodes": nodes,
	})
}

// NodeExporterInstall 在集群一键部署 node-exporter（仅安装时写一次集群，之后磁盘读取为零写操作）
func (h *Handler) NodeExporterInstall(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	if e := h.K8s.InstallNodeExporter(cid); e != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "node-exporter 部署失败: " + e.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "message": "node-exporter 已部署，正在启动（约数十秒后可在节点页看到磁盘使用率）"})
}

// NodeExporterStatus 返回 node-exporter 安装/就绪状态（供前端安装横幅展示）
func (h *Handler) NodeExporterStatus(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	installed, ready, pods, msg, e := h.K8s.NodeExporterStatus(cid)
	if e != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": e.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"installed": installed, "ready": ready, "pods": pods, "message": msg})
}

// MetricsServerInstall 在集群一键部署 metrics-server（节点 CPU/内存使用率数据源，供 DunHelm CPU/内存列 + HPA）
func (h *Handler) MetricsServerInstall(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	if e := h.K8s.InstallMetricsServer(cid); e != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": "metrics-server 部署失败: " + e.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "message": "metrics-server 已部署，正在启动（约数十秒后可在节点页看到 CPU/内存使用率）"})
}

// MetricsServerStatus 返回 metrics-server 安装/就绪状态（供前端安装横幅展示）
func (h *Handler) MetricsServerStatus(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	installed, ready, msg, pods, e := h.K8s.MetricsServerStatus(cid)
	if e != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": e.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"installed": installed, "ready": ready, "message": msg, "pods": pods})
}

// NodePods 返回指定节点上调度运行的所有 Pod（节点详情用）
func (h *Handler) NodePods(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	node := c.Query("node")
	if node == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 node 参数"})
		return
	}
	pods, err := h.K8s.PodsOnNode(cid, node)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"pods": pods})
}

// Workloads 工作负载（核心只读：实时查询真实集群，支持 ?kind= 过滤）
// CreateWorkload 在真实集群创建工作负载（Deployment/StatefulSet/DaemonSet/Job/CronJob）。
// 仅当显式 ?cluster= 或 body.cluster 指定集群时创建到真实 K8s；未选集群直接返回明确错误，
// 避免静默写入 DB 第一个集群导致"选了 dev 却建到 prod"。
func (h *Handler) CreateWorkload(c *gin.Context) {
	// ProbeBody 健康检查探针（与前端向导一一对齐）。
	type ProbeBody struct {
		Type                string   `json:"type"`
		Path                string   `json:"path"`
		Port                int      `json:"port"`
		Scheme              string   `json:"scheme"`
		Command             []string `json:"command"`
		InitialDelaySeconds int      `json:"initialDelaySeconds"`
		PeriodSeconds       int      `json:"periodSeconds"`
		TimeoutSeconds      int      `json:"timeoutSeconds"`
		FailureThreshold    int      `json:"failureThreshold"`
		SuccessThreshold    int      `json:"successThreshold"`
	}

	// VolumeBody 存储卷（与前端向导一一对齐）。
	type VolumeBody struct {
		Name         string `json:"name"`
		Type         string `json:"type"`
		Claim        string `json:"claim"`
		SizeLimit    string `json:"sizeLimit"`
		Path         string `json:"path"`
		HostPathType string `json:"hostPathType"`
		RefName      string `json:"refName"`
		MountPath    string `json:"mountPath"`
		SubPath      string `json:"subPath"`
		ReadOnly     bool   `json:"readOnly"`
	}

	var body struct {
		Cluster   string `json:"cluster"`
		Kind      string `json:"kind"`
		Name      string `json:"name"`
		Namespace string `json:"namespace"`
		Replicas  int    `json:"replicas"`
		Image     string `json:"image"`
		CPU       string `json:"cpu"`
		Mem       string `json:"mem"`
		CPUReq    string `json:"cpuReq"`
		MemReq    string `json:"memReq"`
		Schedule  string `json:"schedule"`
		Ports     []struct {
			Name          string `json:"name"`
			ContainerPort int    `json:"containerPort"`
			Protocol      string `json:"protocol"`
			HostPort      int    `json:"hostPort"`
		} `json:"ports"`
		Env []struct {
			Name  string `json:"name"`
			Value string `json:"value"`
		} `json:"env"`
		Command []string `json:"command"`
		Args    []string `json:"args"`

		LivenessProbe  *ProbeBody  `json:"livenessProbe"`
		ReadinessProbe *ProbeBody  `json:"readinessProbe"`
		StartupProbe   *ProbeBody  `json:"startupProbe"`
		Volumes        []VolumeBody `json:"volumes"`
	}

	buildProbeBody := func(p *ProbeBody) *k8s.ProbeReq {
		if p == nil {
			return nil
		}
		return &k8s.ProbeReq{
			Type:                p.Type,
			Path:                p.Path,
			Port:                int32(p.Port),
			Scheme:              p.Scheme,
			Command:             p.Command,
			InitialDelaySeconds: int32(p.InitialDelaySeconds),
			PeriodSeconds:       int32(p.PeriodSeconds),
			TimeoutSeconds:      int32(p.TimeoutSeconds),
			FailureThreshold:    int32(p.FailureThreshold),
			SuccessThreshold:    int32(p.SuccessThreshold),
		}
	}
	if e := c.ShouldBindJSON(&body); e != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请求体解析失败: " + e.Error()})
		return
	}
	cid, err := h.clusterIDWith(c, body.Cluster)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	if body.Name == "" || body.Namespace == "" || body.Kind == "" || body.Image == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name / namespace / kind / image 均必填"})
		return
	}
	ports := make([]k8s.PortReq, 0, len(body.Ports))
	for _, p := range body.Ports {
		ports = append(ports, k8s.PortReq{
			Name: p.Name, ContainerPort: int32(p.ContainerPort), Protocol: p.Protocol, HostPort: int32(p.HostPort),
		})
	}
	env := make([]k8s.EnvReq, 0, len(body.Env))
	for _, e := range body.Env {
		env = append(env, k8s.EnvReq{Name: e.Name, Value: e.Value})
	}
	req := k8s.CreateWorkloadReq{
		Kind:      body.Kind,
		Name:      body.Name,
		Namespace: body.Namespace,
		Replicas:  int32(body.Replicas),
		Image:     body.Image,
		CPU:       body.CPU,
		Mem:       body.Mem,
		CPUReq:    body.CPUReq,
		MemReq:    body.MemReq,
		Schedule:  body.Schedule,
		Ports:     ports,
		Env:       env,
		Command:   body.Command,
		Args:      body.Args,

		LivenessProbe:  buildProbeBody(body.LivenessProbe),
		ReadinessProbe: buildProbeBody(body.ReadinessProbe),
		StartupProbe:   buildProbeBody(body.StartupProbe),

		Volumes: make([]k8s.VolumeReq, 0, len(body.Volumes)),
	}
	for _, v := range body.Volumes {
		req.Volumes = append(req.Volumes, k8s.VolumeReq{
			Name:         v.Name,
			Type:         v.Type,
			Claim:        v.Claim,
			SizeLimit:    v.SizeLimit,
			Path:         v.Path,
			HostPathType: v.HostPathType,
			RefName:      v.RefName,
			MountPath:    v.MountPath,
			SubPath:      v.SubPath,
			ReadOnly:     v.ReadOnly,
		})
	}
	if e := h.K8s.CreateWorkload(cid, req); e != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": e.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

func (h *Handler) Workloads(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	list, err := h.K8s.Workloads(cid)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	if kind := c.Query("kind"); kind != "" {
		filtered := list[:0]
		for _, w := range list {
			if w.Kind == kind {
				filtered = append(filtered, w)
			}
		}
		list = filtered
	}
	c.JSON(http.StatusOK, list)
}

// Jobs 任务 / 定时任务（核心只读：实时查询真实集群，支持 ?kind= 过滤）
func (h *Handler) Jobs(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	list, err := h.K8s.Jobs(cid)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	if kind := c.Query("kind"); kind != "" {
		filtered := list[:0]
		for _, j := range list {
			if j.Kind == kind {
				filtered = append(filtered, j)
			}
		}
		list = filtered
	}
	c.JSON(http.StatusOK, list)
}

// Pipelines 流水线
func (h *Handler) Pipelines(c *gin.Context) {
	cid, _ := h.clusterID(c)
	list, err := h.Store.Pipelines(cid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// 给每条流水线补「最近 N 次构建状态」数组，供卡片上的构建历史条按状态填色（绿=ok / 红=err / 蓝=running / 灰=aborted）。
	for i := range list {
		sts, err := h.Store.RecentBuildStatuses(list[i].Name, 20, cid)
		if err != nil {
			// 单条失败不阻断整个列表；保持空数组让前端显示「暂无构建」
			list[i].RecentBuilds = []string{}
			continue
		}
		if sts == nil {
			list[i].RecentBuilds = []string{}
		} else {
			list[i].RecentBuilds = sts
		}
	}
	c.JSON(http.StatusOK, list)
}

// CreatePipeline 创建流水线（自定义阶段定义）
func (h *Handler) CreatePipeline(c *gin.Context) {
	cid, _ := h.clusterID(c)
	var body struct {
		Name             string `json:"name"`
		Repo             string `json:"repo"`
		Branch           string `json:"branch"`
		Trigger          string `json:"trigger"`
		Env              string `json:"env"`
		TriggerMode      string `json:"triggerMode"`
		DefaultImage     string `json:"defaultImage"`
		TargetNamespace  string `json:"targetNamespace"`
		TargetWorkload   string `json:"targetWorkload"`
		Cluster          string `json:"cluster"`
		Runtime          string `json:"runtime"`
		BuilderType      string `json:"builderType"`
		MavenSettings    *string `json:"mavenSettings"`
		IsTemplate       bool   `json:"isTemplate"`
		Stages           []struct {
			Name    string `json:"name"`
			Enabled *bool  `json:"enabled"`
			Kind    string `json:"kind"`
			Desc    string `json:"desc"`
			Config  string `json:"config,omitempty"`
			ParallelOf string `json:"parallelOf,omitempty"`
		} `json:"stages"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请求体解析失败: " + err.Error()})
		return
	}
	name := strings.TrimSpace(body.Name)
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "流水线名称不能为空"})
		return
	}
	if _, err := h.Store.PipelineByName(name, cid); err == nil {
		c.JSON(http.StatusConflict, gin.H{"error": "流水线已存在: " + name})
		return
	}
	stageDefs := body.Stages
	if len(stageDefs) == 0 {
		defOn := true
		stageDefs = []struct {
			Name    string `json:"name"`
			Enabled *bool  `json:"enabled"`
			Kind    string `json:"kind"`
			Desc    string `json:"desc"`
			Config  string `json:"config,omitempty"`
			ParallelOf string `json:"parallelOf,omitempty"`
		}{
			{Name: "Clone", Enabled: &defOn}, {Name: "Build", Enabled: &defOn},
			{Name: "Test", Enabled: &defOn}, {Name: "Image", Enabled: &defOn},
			{Name: "Deploy", Enabled: &defOn},
		}
	}
	stages := make(model.StageSlice, 0, len(stageDefs))
	for _, s := range stageDefs {
		if nm := strings.TrimSpace(s.Name); nm != "" {
			enabled := true
			if s.Enabled != nil {
				enabled = *s.Enabled
			}
			stages = append(stages, model.Stage{Name: nm, Enabled: &enabled, Kind: s.Kind, Desc: s.Desc, ParallelOf: s.ParallelOf, Config: s.Config})
		}
	}
	if len(stages) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "至少需要一个阶段"})
		return
	}
	tm := strings.TrimSpace(body.TriggerMode)
	if tm == "" {
		tm = "git"
	}
	p := &model.Pipeline{
		Name:            name,
		Repo:            strings.TrimSpace(body.Repo),
		Branch:          strings.TrimSpace(body.Branch),
		Trigger:         strings.TrimSpace(body.Trigger),
		Env:             strings.TrimSpace(body.Env),
		ClusterID:       cid,
		IsTemplate:      body.IsTemplate,
		LastStatus:      "ok",
		Stages:          stages,
		Spark:           model.IntSlice{90, 92, 88, 95, 91, 93},
		TriggerMode:     tm,
		DefaultImage:    strings.TrimSpace(body.DefaultImage),
		TargetNamespace: strings.TrimSpace(body.TargetNamespace),
		TargetWorkload:  strings.TrimSpace(body.TargetWorkload),
		Cluster:         strings.TrimSpace(body.Cluster),
		Runtime:         strings.TrimSpace(body.Runtime),
		BuilderType:     strings.TrimSpace(body.BuilderType),
	}
	if body.MavenSettings != nil {
		p.MavenSettings = *body.MavenSettings
	}
	if err := h.Store.CreatePipeline(p); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditPipelineCreate, "pipeline", name, cid, "ok", "cluster="+strconv.FormatUint(uint64(cid), 10))
	c.JSON(http.StatusOK, gin.H{"ok": true, "name": name})
}

// PipelineDetail 流水线详情（含该流水线构建历史）
// 读路径回退：本集群未找到时，尝试公共模板（is_template=true，跨集群只读），
// 使新集群创建流水线时可参照已有模板的阶段结构。
func (h *Handler) PipelineDetail(c *gin.Context) {
	cid, _ := h.clusterID(c)
	name := c.Param("name")
	p, err := h.Store.PipelineByName(name, cid)
	if err != nil {
		// 回退：尝试公共模板（跨集群只读）
		p, err = h.Store.PipelineTemplateByName(name)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "流水线不存在: " + name})
			return
		}
	}
	builds, _ := h.Store.Builds(name, cid)
	c.JSON(http.StatusOK, gin.H{"pipeline": p, "builds": builds})
}

// UpdatePipeline 编辑流水线（阶段定义 / 配置）
func (h *Handler) UpdatePipeline(c *gin.Context) {
	cid, _ := h.clusterID(c)
	name := c.Param("name")
	if _, err := h.Store.PipelineByName(name, cid); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "流水线不存在: " + name})
		return
	}
	var body struct {
		Repo            string `json:"repo"`
		Branch          string `json:"branch"`
		Trigger         string `json:"trigger"`
		Env             string `json:"env"`
		TriggerMode     string `json:"triggerMode"`
		DefaultImage    string `json:"defaultImage"`
		TargetNamespace string `json:"targetNamespace"`
		TargetWorkload  string `json:"targetWorkload"`
		Cluster         string `json:"cluster"`
		Runtime         string `json:"runtime"`
		BuilderType     string `json:"builderType"`
		MavenSettings   *string `json:"mavenSettings"`
		IsTemplate      *bool  `json:"isTemplate"`
		Stages          []struct {
			Name    string `json:"name"`
			Enabled *bool  `json:"enabled"`
			Kind    string `json:"kind"`
			Desc    string `json:"desc"`
			Config  string `json:"config,omitempty"`
			ParallelOf string `json:"parallelOf,omitempty"`
		} `json:"stages"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请求体解析失败: " + err.Error()})
		return
	}
	stages := make(model.StageSlice, 0, len(body.Stages))
	for _, s := range body.Stages {
		if nm := strings.TrimSpace(s.Name); nm != "" {
			enabled := true
			if s.Enabled != nil {
				enabled = *s.Enabled
			}
			stages = append(stages, model.Stage{Name: nm, Enabled: &enabled, Kind: s.Kind, Desc: s.Desc, ParallelOf: s.ParallelOf, Config: s.Config})
		}
	}
	if len(stages) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "至少需要一个阶段"})
		return
	}
	p := &model.Pipeline{
		Name:            name,
		Repo:            strings.TrimSpace(body.Repo),
		Branch:          strings.TrimSpace(body.Branch),
		Trigger:         strings.TrimSpace(body.Trigger),
		Env:             strings.TrimSpace(body.Env),
		Stages:          stages,
		TriggerMode:     strings.TrimSpace(body.TriggerMode),
		DefaultImage:    strings.TrimSpace(body.DefaultImage),
		TargetNamespace: strings.TrimSpace(body.TargetNamespace),
		TargetWorkload:  strings.TrimSpace(body.TargetWorkload),
		Cluster:         strings.TrimSpace(body.Cluster),
		Runtime:         strings.TrimSpace(body.Runtime),
		BuilderType:     strings.TrimSpace(body.BuilderType),
	}
	if body.IsTemplate != nil {
		p.IsTemplate = *body.IsTemplate
	}
	if err := h.Store.UpdatePipeline(p, body.MavenSettings, cid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditPipelineUpdate, "pipeline", name, cid, "ok", "cluster="+strconv.FormatUint(uint64(cid), 10))
	c.JSON(http.StatusOK, gin.H{"ok": true, "name": name})
}

// GetMavenSettings 读取当前集群级 Maven 全局配置（mirror / proxy）。无记录返回空内容。
func (h *Handler) GetMavenSettings(c *gin.Context) {
	cid, _ := h.clusterID(c)
	m, err := h.Store.GetMavenGlobalSettings(cid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, m)
}

// SaveMavenSettings 保存（upsert）当前集群级 Maven 全局配置。
func (h *Handler) SaveMavenSettings(c *gin.Context) {
	cid, _ := h.clusterID(c)
	var body struct {
		Content string `json:"content"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请求体解析失败: " + err.Error()})
		return
	}
	if err := h.Store.SaveMavenGlobalSettings(body.Content, cid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// UpdatePipelineStages 仅更新阶段定义（启用/关闭/重命名/增删/重排序），不动其他字段。
// 用于详情页内联编辑阶段。
func (h *Handler) UpdatePipelineStages(c *gin.Context) {
	cid, _ := h.clusterID(c)
	name := c.Param("name")
	p, err := h.Store.PipelineByName(name, cid)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "流水线不存在: " + name})
		return
	}
	var body struct {
		Stages []struct {
			Name    string `json:"name"`
			Enabled *bool  `json:"enabled"`
			Kind    string `json:"kind"`
			Desc    string `json:"desc"`
			Config  string `json:"config,omitempty"`
			ParallelOf string `json:"parallelOf,omitempty"`
		} `json:"stages"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请求体解析失败: " + err.Error()})
		return
	}
	stages := make(model.StageSlice, 0, len(body.Stages))
	for _, s := range body.Stages {
		if nm := strings.TrimSpace(s.Name); nm != "" {
			enabled := true
			if s.Enabled != nil {
				enabled = *s.Enabled
			}
			stages = append(stages, model.Stage{Name: nm, Enabled: &enabled, Kind: s.Kind, Desc: s.Desc, ParallelOf: s.ParallelOf, Config: s.Config})
		}
	}
	if len(stages) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "至少需要一个阶段"})
		return
	}
	if err := h.Store.PatchPipeline(name, cid, map[string]interface{}{"stages": stages}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	p.Stages = stages
	c.JSON(http.StatusOK, gin.H{"ok": true, "name": name, "stages": stages})
}

// PipelineYAML 序列化整个流水线（含基本信息 + 触发模式 + 阶段）为 YAML。
// GET 返回 yaml 字符串；PUT 接收 yaml 字符串并整体回写。
// YAML 字段命名与 model 序列化字段一致，便于双向编辑。
func (h *Handler) PipelineYAML(c *gin.Context) {
	cid, _ := h.clusterID(c)
	name := c.Param("name")
	p, err := h.Store.PipelineByName(name, cid)
	if err != nil {
		// 回退：尝试公共模板（跨集群只读，仅 GET 读取）
		p, err = h.Store.PipelineTemplateByName(name)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "流水线不存在: " + name})
			return
		}
	}
	switch c.Request.Method {
	case http.MethodGet:
		// 序列化整个 pipeline（仅 yaml.Marshal 已支持的字段，spark/lastRun/lastStatus/duration 由前端拉详情补）
		type yamlPayload struct {
			Name             string            `yaml:"name"`
			Repo             string            `yaml:"repo"`
			Branch           string            `yaml:"branch"`
			Trigger          string            `yaml:"trigger"`
			Env              string            `yaml:"env"`
			TriggerMode      string            `yaml:"triggerMode"`
			DefaultImage     string            `yaml:"defaultImage"`
			TargetNamespace  string            `yaml:"targetNamespace"`
			TargetWorkload   string            `yaml:"targetWorkload"`
			Stages           []struct {
				Name    string `yaml:"name"`
				Enabled *bool  `yaml:"enabled,omitempty"`
				Kind    string `yaml:"kind,omitempty"`
				Desc    string `yaml:"desc,omitempty"`
			Config  string `yaml:"config,omitempty"`
				ParallelOf string `yaml:"parallelOf,omitempty"`
			} `yaml:"stages"`
		}
		yp := yamlPayload{
			Name: p.Name, Repo: p.Repo, Branch: p.Branch, Trigger: p.Trigger, Env: p.Env,
			TriggerMode: p.TriggerMode, DefaultImage: p.DefaultImage,
			TargetNamespace: p.TargetNamespace, TargetWorkload: p.TargetWorkload,
		}
		for _, s := range p.Stages {
			stage := struct {
				Name    string `yaml:"name"`
				Enabled *bool  `yaml:"enabled,omitempty"`
				Kind    string `yaml:"kind,omitempty"`
				Desc    string `yaml:"desc,omitempty"`
			Config  string `yaml:"config,omitempty"`
				ParallelOf string `yaml:"parallelOf,omitempty"`
			}{Name: s.Name, Enabled: s.Enabled, Kind: s.Kind, Desc: s.Desc, ParallelOf: s.ParallelOf, Config: s.Config}
			yp.Stages = append(yp.Stages, stage)
		}
		out, err := yaml.Marshal(yp)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "YAML 序列化失败: " + err.Error()})
			return
		}
		c.Data(http.StatusOK, "text/plain; charset=utf-8", out)
	case http.MethodPut:
		body, err := io.ReadAll(c.Request.Body)
		if err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "读取请求体失败: " + err.Error()})
			return
		}
		var yp struct {
			Name             string `yaml:"name"`
			Repo             string `yaml:"repo"`
			Branch           string `yaml:"branch"`
			Trigger          string `yaml:"trigger"`
			Env              string `yaml:"env"`
			TriggerMode      string `yaml:"triggerMode"`
			DefaultImage     string `yaml:"defaultImage"`
			TargetNamespace  string `yaml:"targetNamespace"`
			TargetWorkload   string `yaml:"targetWorkload"`
			Stages           []struct {
				Name       string `yaml:"name"`
				Enabled    *bool  `yaml:"enabled"`
				Kind       string `yaml:"kind"`
				Desc       string `yaml:"desc"`
				ParallelOf string `yaml:"parallelOf,omitempty"`
				Config     string `yaml:"config,omitempty"`
			} `yaml:"stages"`
		}
		if err := yaml.Unmarshal(body, &yp); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "YAML 解析失败: " + err.Error()})
			return
		}
		stages := make(model.StageSlice, 0, len(yp.Stages))
		for _, s := range yp.Stages {
			if nm := strings.TrimSpace(s.Name); nm != "" {
				enabled := true
				if s.Enabled != nil {
					enabled = *s.Enabled
				}
				stages = append(stages, model.Stage{Name: nm, Enabled: &enabled, Kind: s.Kind, Desc: s.Desc, ParallelOf: s.ParallelOf, Config: s.Config})
			}
		}
		if err := h.Store.UpdatePipeline(&model.Pipeline{
			Name: name,
			Repo: strings.TrimSpace(yp.Repo), Branch: strings.TrimSpace(yp.Branch),
			Trigger: strings.TrimSpace(yp.Trigger), Env: strings.TrimSpace(yp.Env),
			TriggerMode: strings.TrimSpace(yp.TriggerMode),
			DefaultImage: strings.TrimSpace(yp.DefaultImage),
			TargetNamespace: strings.TrimSpace(yp.TargetNamespace),
			TargetWorkload: strings.TrimSpace(yp.TargetWorkload),
			Stages: stages,
		}, nil, cid); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, gin.H{"ok": true, "name": name})
	default:
		c.JSON(http.StatusMethodNotAllowed, gin.H{"error": "method not allowed"})
	}
}

// SetPipelineSource 设置流水线的「默认镜像 / 目标命名空间 / 工作负载」，用于 image 模式。
func (h *Handler) SetPipelineSource(c *gin.Context) {
	cid, _ := h.clusterID(c)
	name := c.Param("name")
	if _, err := h.Store.PipelineByName(name, cid); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "流水线不存在: " + name})
		return
	}
	var body struct {
		TriggerMode     string `json:"triggerMode"`
		DefaultImage    string `json:"defaultImage"`
		TargetNamespace string `json:"targetNamespace"`
		TargetWorkload  string `json:"targetWorkload"`
		Repo            string `json:"repo"`
		Branch          string `json:"branch"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请求体解析失败: " + err.Error()})
		return
	}
	cols := map[string]interface{}{
		"trigger_mode":      strings.TrimSpace(body.TriggerMode),
		"default_image":     strings.TrimSpace(body.DefaultImage),
		"target_namespace": strings.TrimSpace(body.TargetNamespace),
		"target_workload":  strings.TrimSpace(body.TargetWorkload),
		"repo":              strings.TrimSpace(body.Repo),
		"branch":            strings.TrimSpace(body.Branch),
	}
	if err := h.Store.PatchPipeline(name, cid, cols); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "name": name})
}

// DeletePipeline 删除流水线（级联清理其构建记录）
func (h *Handler) DeletePipeline(c *gin.Context) {
	cid, _ := h.clusterID(c)
	name := c.Param("name")
	if err := h.Store.DeletePipeline(name, cid); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditPipelineDelete, "pipeline", name, cid, "ok", "cluster="+strconv.FormatUint(uint64(cid), 10))
	c.JSON(http.StatusOK, gin.H{"ok": true, "name": name})
}

// SetPipelineTemplate 设置/取消流水线为公共模板（is_template 标记）。
// 写操作严格限定本集群（cid），避免跨集群越权修改别集群的模板。
func (h *Handler) SetPipelineTemplate(c *gin.Context) {
	cid, _ := h.clusterID(c)
	name := c.Param("name")
	if _, err := h.Store.PipelineByName(name, cid); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "流水线不存在: " + name})
		return
	}
	var body struct {
		IsTemplate bool `json:"isTemplate"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请求体解析失败: " + err.Error()})
		return
	}
	if err := h.Store.PatchPipeline(name, cid, map[string]interface{}{"is_template": body.IsTemplate}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true, "name": name, "isTemplate": body.IsTemplate})
}

// RunPipeline 触发构建（异步执行，返回构建编号）。
// body: { triggerMode, branch, image, repo, namespace, workload }
// 后端 / 前端 模式：上传包走 /pipelines/:name/upload，提交 run 时携带 artifactPath 字段。
func (h *Handler) RunPipeline(c *gin.Context) {
	cid, _ := h.clusterID(c)
	name := c.Param("name")
	p, err := h.Store.PipelineByName(name, cid)
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "流水线不存在: " + name})
		return
	}
	var body struct {
		TriggerMode  string `json:"triggerMode"`
		Branch       string `json:"branch"`
		Image        string `json:"image"`
		Repo         string `json:"repo"`
		Namespace    string `json:"namespace"`
		Workload     string `json:"workload"`
		ArtifactPath string `json:"artifactPath"` // 后端 / 前端 模式下，已上传的文件路径
		FrontendPath string `json:"frontendPath"`
	}
	_ = c.ShouldBindJSON(&body)
	src := model.BuildSource{
		TriggerMode:  strings.TrimSpace(body.TriggerMode),
		Branch:       strings.TrimSpace(body.Branch),
		Image:        strings.TrimSpace(body.Image),
		Repo:         strings.TrimSpace(body.Repo),
		Namespace:    strings.TrimSpace(body.Namespace),
		Workload:     strings.TrimSpace(body.Workload),
		ArtifactPath: strings.TrimSpace(body.ArtifactPath),
		FrontendPath: strings.TrimSpace(body.FrontendPath),
	}
	// 默认值回退到流水线配置
	if src.TriggerMode == "" {
		src.TriggerMode = p.TriggerMode
		if src.TriggerMode == "" {
			src.TriggerMode = "git"
		}
	}
	if src.Branch == "" {
		src.Branch = p.Branch
	}
	if src.Repo == "" {
		src.Repo = p.Repo
	}
	if src.Image == "" {
		src.Image = p.DefaultImage
	}
	// 已有镜像场景：流水线含「镜像」节点时，从其 config 派生默认镜像，避免 deploy 节点再手填。
	if src.Image == "" {
		for _, st := range p.Stages {
			if st.Kind == "image" {
				if img := stageConfigImage(st.Config); img != "" {
					src.Image = img
					break
				}
			}
		}
	}
	if src.Namespace == "" {
		src.Namespace = p.TargetNamespace
	}
	if src.Workload == "" {
		src.Workload = p.TargetWorkload
	}
	// 校验：后端 / 前端模式必须已上传
	if src.TriggerMode == "backend" && src.ArtifactPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "后端包模式：请先在「触发源」Tab 上传后端编译包"})
		return
	}
	if src.TriggerMode == "frontend" && src.FrontendPath == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "前端包模式：请先在「触发源」Tab 上传前端静态包"})
		return
	}
	if src.TriggerMode == "image" && src.Image == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "镜像模式：请提供 defaultImage 或在触发源填写镜像"})
		return
	}
	no, err := h.CI.Run(name, src, cid)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditPipelineRun, "pipeline", name, cid, "ok", fmt.Sprintf("buildNo=%v branch=%s", no, src.Branch))
	c.JSON(http.StatusOK, gin.H{"ok": true, "buildNo": no})
}

// stageConfigImage 从 stage.Config（JSON 字符串）中取出 image 字段，用于「已有镜像」场景派生部署镜像。
func stageConfigImage(cfg string) string {
	if strings.TrimSpace(cfg) == "" {
		return ""
	}
	var m map[string]string
	if err := json.Unmarshal([]byte(cfg), &m); err != nil {
		return ""
	}
	return strings.TrimSpace(m["image"])
}

// UploadPipeline 上传后端编译包（.tar.gz/.tgz）或前端静态包（.zip）。
// 真实存到 data/pipelines/<name>/<timestamp>.<ext>，返回 artifactPath / frontendPath，
// 前端在「运行」时回传给 /pipelines/:name/run。
// 字段：mode=backend|frontend，file=二进制。
func (h *Handler) UploadPipeline(c *gin.Context) {
	cid, _ := h.clusterID(c)
	name := c.Param("name")
	if _, err := h.Store.PipelineByName(name, cid); err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "流水线不存在: " + name})
		return
	}
	stage := strings.TrimSpace(c.Param("stage"))
	if stage == "" {
		// 兼容旧路由（不带 stage），落盘到 pipelines/<name>/
		stage = "_legacy"
	}
	mode := strings.TrimSpace(c.PostForm("mode"))
	if mode != "backend" && mode != "frontend" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "mode 必须为 backend 或 frontend"})
		return
	}
	fileHdr, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "未提供 file 字段: " + err.Error()})
		return
	}
	// 大小限制 256MB
	const maxBytes = 256 << 20
	if fileHdr.Size > maxBytes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "包大小超过 256MB 上限"})
		return
	}
	// 取扩展名（注意 .tar.gz 需特殊处理，filepath.Ext 只会返回 .gz）
	ext := packageExt(fileHdr.Filename)
	// 扩展名白名单：后端支持 jar/war/zip/tar.gz，前端仅 zip
	if mode == "backend" {
		switch ext {
		case ".jar", ".war", ".zip", ".tar.gz", ".tgz", ".gz":
			// 合法
		default:
			c.JSON(http.StatusBadRequest, gin.H{"error": "后端包仅支持 .jar / .war / .zip / .tar.gz / .tgz / .gz"})
			return
		}
	} else {
		if ext != ".zip" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "前端包仅支持 .zip"})
			return
		}
	}
	// magic bytes 校验：打开文件读前若干字节，按扩展名核对真实格式，防止扩展名伪造
	src, err := fileHdr.Open()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "打开上传文件失败: " + err.Error()})
		return
	}
	defer src.Close()
	head := make([]byte, 8)
	hn, _ := io.ReadFull(src, head)
	head = head[:hn]
	if err := validatePackageMagic(mode, ext, head); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	dir := filepath.Join("data", "pipelines", name, stage)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "创建目录失败: " + err.Error()})
		return
	}
	ts := time.Now().Format("20060102-150405")
	filename := ts + ext
	dst := filepath.Join(dir, filename)
	if err := saveUploaded(src, head, dst); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": "保存失败: " + err.Error()})
		return
	}
	abs, _ := filepath.Abs(dst)
	field := "artifactPath"
	if mode == "frontend" {
		field = "frontendPath"
	}
	out := gin.H{
		"ok":       true,
		"name":     name,
		"mode":     mode,
		"size":     fileHdr.Size,
		"filename": fileHdr.Filename,
		"savedAs":  filename,
	}
	out[field] = abs
	c.JSON(http.StatusOK, out)
}

// packageExt 取文件扩展名，对 .tar.gz 这种双段扩展名做正确处理
// （标准库 filepath.Ext("a.tar.gz") 只会返回 ".gz"）。
func packageExt(name string) string {
	n := strings.ToLower(name)
	if strings.HasSuffix(n, ".tar.gz") {
		return ".tar.gz"
	}
	return strings.ToLower(filepath.Ext(n))
}

// 常见归档格式的 magic bytes：
//   ZIP / JAR / WAR : 50 4B 03 04（PK..），空归档 50 4B 05 06，分卷 50 4B 07 08
//   GZIP / TAR.GZ   : 1F 8B 08
var (
	zipMagic   = []byte{0x50, 0x4B, 0x03, 0x04}
	zipEmpty   = []byte{0x50, 0x4B, 0x05, 0x06}
	zipSpanned = []byte{0x50, 0x4B, 0x07, 0x08}
	gzipMagic  = []byte{0x1F, 0x8B, 0x08}
)

// validatePackageMagic 按扩展名核对二进制头部魔数，防止仅改扩展名伪造格式
func validatePackageMagic(mode, ext string, head []byte) error {
	switch ext {
	case ".jar", ".war", ".zip":
		if !(bytes.HasPrefix(head, zipMagic) || bytes.HasPrefix(head, zipEmpty) || bytes.HasPrefix(head, zipSpanned)) {
			return fmt.Errorf("文件内容不是合法的 ZIP/JAR/WAR 格式（缺少 PK 魔数）")
		}
	case ".tar.gz", ".tgz", ".gz":
		if !bytes.HasPrefix(head, gzipMagic) {
			return fmt.Errorf("文件内容不是合法的 GZIP/TAR.GZ 格式（缺少 1F 8B 08 魔数）")
		}
	default:
		return fmt.Errorf("不支持的扩展名: %s", ext)
	}
	return nil
}

// saveUploaded 把已打开且已读取头部的 multipart 文件落盘：
// 先把已读出的 head 写回，再从 src 当前位置续写剩余内容（避免重复打开/seek）。
func saveUploaded(src multipart.File, head []byte, dst string) error {
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	defer out.Close()
	if len(head) > 0 {
		if _, err := out.Write(head); err != nil {
			return err
		}
	}
	_, err = io.Copy(out, src)
	return err
}

// Builds 构建记录（?pipeline= 过滤；?page&pageSize 分页，默认 page=1, pageSize=20）
func (h *Handler) Builds(c *gin.Context) {
	cid, _ := h.clusterID(c)
	pipeline := c.Query("pipeline")
	page, _ := strconv.Atoi(c.DefaultQuery("page", "1"))
	pageSize, _ := strconv.Atoi(c.DefaultQuery("pageSize", "20"))
	if page < 1 {
		page = 1
	}
	if pageSize < 1 || pageSize > 200 {
		pageSize = 20
	}
	offset := (page - 1) * pageSize
	total, list, err := h.Store.BuildsPaginated(pipeline, cid, offset, pageSize)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"list":     list,
		"total":    total,
		"page":     page,
		"pageSize": pageSize,
	})
}

// GetBuildRetention 读取构建记录保留条数（平台级配置）
func (h *Handler) GetBuildRetention(c *gin.Context) {
	keep, err := h.Store.GetBuildRetention()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"keep": keep})
}

// SaveBuildRetention 保存构建记录保留条数（下限保护 1 条），保存后立即跨流水线套用清理。
func (h *Handler) SaveBuildRetention(c *gin.Context) {
	var body struct {
		Keep int `json:"keep"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请求体解析失败: " + err.Error()})
		return
	}
	if body.Keep < 1 {
		body.Keep = 1
	}
	if err := h.Store.SaveBuildRetention(body.Keep); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	// 配置降低后，立即对各流水线套用新保留条数（删除超出部分）
	_ = h.Store.PurgeAllOldBuilds(body.Keep)
	c.JSON(http.StatusOK, gin.H{"ok": true, "keep": body.Keep})
}

// BuildDetail 构建详情（含各阶段 console 日志）
func (h *Handler) BuildDetail(c *gin.Context) {
	b, err := h.Store.BuildByNo(c.Param("no"))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "构建不存在: " + c.Param("no")})
		return
	}
	c.JSON(http.StatusOK, b)
}

// AbortBuild 中止正在运行的构建
func (h *Handler) AbortBuild(c *gin.Context) {
	no := c.Param("no")
	if err := h.CI.Abort(no); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditPipelineRunAbort, "pipeline", "build", 0, "ok", fmt.Sprintf("buildNo=%v", no))
	c.JSON(http.StatusOK, gin.H{"ok": true, "buildNo": no})
}

// Repos 镜像仓库 + 存储配额
func (h *Handler) Repos(c *gin.Context) {
	list, err := h.Store.Repos()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"repos": list,
		"storage": gin.H{"used": 13.2, "total": 50, "unit": "GiB"},
	})
}

// ToggleFavorite 切换仓库收藏（持久化写操作）
func (h *Handler) ToggleFavorite(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	if err := h.Store.ToggleFavorite(uint(id)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Workspaces 企业空间
func (h *Handler) Workspaces(c *gin.Context) {
	list, _ := h.Store.Workspaces()
	c.JSON(http.StatusOK, list)
}

// CreateWorkspace 创建企业空间
func (h *Handler) CreateWorkspace(c *gin.Context) {
	var w model.Workspace
	if err := c.ShouldBindJSON(&w); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	w.Projects, w.Members, w.Status = 0, 0, "ok"
	if err := h.Store.CreateWorkspace(&w); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, w)
}

// Users 用户列表
func (h *Handler) Users(c *gin.Context) {
	list, _ := h.Store.Users()
	c.JSON(http.StatusOK, list)
}

// GetUser 单查（编辑回填）
func (h *Handler) GetUser(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	u, err := h.Store.UserByID(uint(id))
	if err != nil {
		c.JSON(http.StatusNotFound, gin.H{"error": "user not found"})
		return
	}
	c.JSON(http.StatusOK, u)
}

// CreateUser 邀请用户（落库，初始为待审批，Active=true）
func (h *Handler) CreateUser(c *gin.Context) {
	var body struct {
		Name     string `json:"name"`
		Email    string `json:"email"`
		Role     string `json:"role"`
		Password string `json:"password"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name required"})
		return
	}
	if body.Role == "" {
		body.Role = model.RoleViewer // 默认访客
	}
	pw := body.Password
	if pw == "" {
		pw = model.DefaultUserPassword // 未提供密码时使用统一初始密码
	}
	hash, err := crypto.HashPassword(pw)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	u := model.User{
		Name:     body.Name,
		Email:    body.Email,
		Role:     body.Role,
		Password: hash,
		Status:   "ok",
		LastLogin: "—",
		Active:   true, // 新建默认启用
	}
	if err := h.Store.CreateUser(&u); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditUserCreate, "user", u.Name, 0, "ok", "role="+u.Role+" email="+u.Email)
	c.JSON(http.StatusCreated, u)
}

// UpdateUser 更新用户基本信息
func (h *Handler) UpdateUser(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var body struct {
		Name     *string `json:"name"`
		Email    *string `json:"email"`
		Role     *string `json:"role"`
		Password *string `json:"password"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	fields := map[string]interface{}{}
	if body.Name != nil {
		fields["name"] = *body.Name
	}
	if body.Email != nil {
		fields["email"] = *body.Email
	}
	if body.Role != nil {
		// 校验 role 是有效角色
		if _, err := h.Store.RoleBySlug(*body.Role); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "invalid role: " + *body.Role})
			return
		}
		fields["role"] = *body.Role
	}
	if body.Password != nil && *body.Password != "" {
		hash, err := crypto.HashPassword(*body.Password)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
			return
		}
		fields["password"] = hash
	}
	if len(fields) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no fields to update"})
		return
	}
	if err := h.Store.UpdateUser(uint(id), fields); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	u, _ := h.Store.UserByID(uint(id))
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditUserUpdate, "user", u.Name, 0, "ok", "")
	c.JSON(http.StatusOK, u)
}

// ResetUserPassword 管理员重置某用户密码（不返回明文，默认回退到统一初始密码）
func (h *Handler) ResetUserPassword(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var body struct {
		Password string `json:"password"`
	}
	_ = c.ShouldBindJSON(&body)
	pw := body.Password
	if pw == "" {
		pw = model.DefaultUserPassword
	}
	hash, err := crypto.HashPassword(pw)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if err := h.Store.UpdateUser(uint(id), map[string]interface{}{"password": hash}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	u, _ := h.Store.UserByID(uint(id))
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditUserResetPassword, "user", u.Name, 0, "ok", "")
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// DeleteUser 删除用户（级联清理权限）
func (h *Handler) DeleteUser(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	u, _ := h.Store.UserByID(uint(id))
	if err := h.Store.DeleteUser(uint(id)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if u != nil {
		audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditUserDelete, "user", u.Name, 0, "ok", "")
	}
	c.Status(http.StatusNoContent)
}

// SetUserStatus 设置状态（ok / pending / locked）
func (h *Handler) SetUserStatus(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var body struct {
		Status string `json:"status"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.Status != "ok" && body.Status != "pending" && body.Status != "locked" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid status"})
		return
	}
	if err := h.Store.UpdateUser(uint(id), map[string]interface{}{"status": body.Status}); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	u, _ := h.Store.UserByID(uint(id))
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditUserSetStatus, "user", u.Name, 0, "ok", "status="+body.Status)
	c.JSON(http.StatusOK, u)
}

// SetUserActive 启用/禁用用户
func (h *Handler) SetUserActive(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var body struct {
		Active bool `json:"active"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if err := h.Store.SetUserActive(uint(id), body.Active); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	u, _ := h.Store.UserByID(uint(id))
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditUserSetActive, "user", u.Name, 0, "ok", "active="+strconv.FormatBool(body.Active))
	c.JSON(http.StatusOK, u)
}

// ---------- 角色（RBAC） ----------
func (h *Handler) Roles(c *gin.Context) {
	list, _ := h.Store.Roles()
	c.JSON(http.StatusOK, list)
}

// CreateRole 创建自定义角色（系统角色不可创建）
func (h *Handler) CreateRole(c *gin.Context) {
	var r model.Role
	if err := c.ShouldBindJSON(&r); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if r.Slug == "" || r.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "slug and name required"})
		return
	}
	r.IsSystem = false
	if err := h.Store.CreateRole(&r); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditRoleCreate, "role", r.Slug, 0, "ok", "name="+r.Name)
	c.JSON(http.StatusCreated, r)
}

// UpdateRole 改角色 name/description（slug/isSystem 不可改）
func (h *Handler) UpdateRole(c *gin.Context) {
	slug := c.Param("slug")
	var body struct {
		Name        *string `json:"name"`
		Description *string `json:"description"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	fields := map[string]interface{}{}
	if body.Name != nil {
		fields["name"] = *body.Name
	}
	if body.Description != nil {
		fields["description"] = *body.Description
	}
	if len(fields) == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "no fields to update"})
		return
	}
	if err := h.Store.UpdateRole(slug, fields); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	r, _ := h.Store.RoleBySlug(slug)
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditRoleUpdate, "role", slug, 0, "ok", "")
	c.JSON(http.StatusOK, r)
}

// DeleteRole 删除角色（仅 IsSystem=false 允许）
func (h *Handler) DeleteRole(c *gin.Context) {
	slug := c.Param("slug")
	aff, err := h.Store.DeleteRole(slug)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if aff == 0 {
		c.JSON(http.StatusBadRequest, gin.H{"error": "system role cannot be deleted or role not found"})
		return
	}
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditRoleDelete, "role", slug, 0, "ok", "")
	c.Status(http.StatusNoContent)
}

// ---------- 用户-集群权限 ----------
// UserPermissions 列出某用户的所有集群授权
func (h *Handler) UserPermissions(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	list, _ := h.Store.UserPermissions(uint(id))
	c.JSON(http.StatusOK, list)
}

// AssignUserPermission 分配/覆盖（按 user_id+cluster_id 唯一）
func (h *Handler) AssignUserPermission(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	var body struct {
		ClusterID  uint     `json:"clusterId"`
		RoleSlug   string   `json:"roleSlug"`
		Namespaces []string `json:"namespaces"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if body.ClusterID == 0 || body.RoleSlug == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "clusterId and roleSlug required"})
		return
	}
	// 校验角色合法
	if _, err := h.Store.RoleBySlug(body.RoleSlug); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid role: " + body.RoleSlug})
		return
	}
	nsJSON, _ := json.Marshal(body.Namespaces)
	p := &model.UserClusterPermission{
		UserID:         uint(id),
		ClusterID:      body.ClusterID,
		RoleSlug:       body.RoleSlug,
		NamespacesJSON: string(nsJSON),
	}
	if err := h.Store.AssignUserPermission(p); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditPermAssign, "permission",
		"user#"+strconv.FormatUint(id, 10)+"/cluster#"+strconv.FormatUint(uint64(body.ClusterID), 10),
		body.ClusterID, "ok", "roleSlug="+body.RoleSlug)
	c.JSON(http.StatusOK, p)
}

// RevokeUserPermission 撤销某用户对某集群的授权
func (h *Handler) RevokeUserPermission(c *gin.Context) {
	id, _ := strconv.ParseUint(c.Param("id"), 10, 64)
	cid, _ := strconv.ParseUint(c.Param("clusterId"), 10, 64)
	if err := h.Store.RevokeUserPermission(uint(id), uint(cid)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditPermRevoke, "permission",
		"user#"+strconv.FormatUint(id, 10)+"/cluster#"+strconv.FormatUint(cid, 10),
		uint(cid), "ok", "")
	c.Status(http.StatusNoContent)
}

// ---------- 当前用户可用集群 ----------
// MyClusters 当前用户可访问的集群列表（平台管理员看全部）
func (h *Handler) MyClusters(c *gin.Context) {
	role := middleware.PlatformRole(c)
	if role == model.RolePlatformAdmin {
		// 全部：实时探测连通性，让 Sidebar/Topbar 显示真实状态
		all, _ := h.Store.Clusters()
		for i := range all {
			h.probeCluster(&all[i])
		}
		c.JSON(http.StatusOK, gin.H{"clusters": all, "isPlatformAdmin": true})
		return
	}
	uid := middleware.UserID(c)
	if uid == 0 {
		c.JSON(http.StatusOK, gin.H{"clusters": []model.Cluster{}, "isPlatformAdmin": false})
		return
	}
	ids, _ := h.Store.MyClusters(uid)
	if len(ids) == 0 {
		c.JSON(http.StatusOK, gin.H{"clusters": []model.Cluster{}, "isPlatformAdmin": false})
		return
	}
	var list []model.Cluster
	if err := h.Store.DB.Where("id IN ?", ids).Order("id").Find(&list).Error; err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	for i := range list {
		h.probeCluster(&list[i])
	}
	c.JSON(http.StatusOK, gin.H{"clusters": list, "isPlatformAdmin": false})
}

// Credentials 凭证列表
// 策略：?cluster= 指定集群 → 读真实 K8s Secret（按类型映射为凭证视图）；
// 未带 cluster → 回退本地 DB 演示数据。
func (h *Handler) Credentials(c *gin.Context) {
	if cid, ok := h.clusterIDOrFallback(c); ok {
		list, err := h.K8s.Credentials(cid)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, list)
		return
	}
	list, _ := h.Store.Credentials()
	c.JSON(http.StatusOK, list)
}

// CreateCredential 新增凭证
// ?cluster= 指定集群 → 在真实集群创建对应类型 K8s Secret；否则回退本地 DB（演示）。
func (h *Handler) CreateCredential(c *gin.Context) {
	var in model.CredentialInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if cid, ok := h.clusterIDOrFallback(c); ok {
		created, err := h.K8s.CreateCredentialSecret(cid, in)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditCredentialCreate, "credential", created.Name, cid, "ok", "scope="+in.Scope+" type="+in.Type)
		c.JSON(http.StatusCreated, created)
		return
	}
	// 无集群：回退本地 DB（演示）
	cred := model.Credential{
		Name:      in.Name,
		Type:      in.Type,
		Scope:     in.Scope,
		SecretRef: "secret/" + in.Name,
		CreatedBy: in.CreatedBy,
		LastUsed:  "刚刚",
		Status:    "ok",
	}
	if err := h.Store.CreateCredential(&cred); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditCredentialCreate, "credential", cred.Name, 0, "ok", "scope="+in.Scope+" type="+in.Type)
	c.JSON(http.StatusCreated, cred)
}

// DeleteCredential 删除凭证（本地 DB 演示数据，按 id）
func (h *Handler) DeleteCredential(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	if err := h.Store.DeleteCredential(uint(id)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditCredentialDelete, "credential", strconv.FormatUint(id, 10), 0, "ok", "")
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// DeleteCredentialCluster 删除真实集群中的凭据 Secret（?cluster=&ns=&name=）
func (h *Handler) DeleteCredentialCluster(c *gin.Context) {
	name := c.Query("name")
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 name"})
		return
	}
	cid, ok := h.clusterIDOrFallback(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请先选择集群"})
		return
	}
	if err := h.K8s.DeleteCredentialSecret(cid, c.Query("ns"), name); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// StorageClasses 存储类
// 策略：?cluster= 指定集群 → 真实 K8s（按"核心只读"原则，无 KubeConfig / 未选集群 → 直接报错）；
// 未带 cluster 参数 → 回退到本地 DB 兼容旧前端 / demo mock。
func (h *Handler) StorageClasses(c *gin.Context) {
	if cid, ok := h.clusterIDOrFallback(c); ok {
		list, err := h.K8s.StorageClasses(cid)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, list)
		return
	}
	list, _ := h.Store.StorageClasses()
	c.JSON(http.StatusOK, list)
}

// CreateStorageClass 新建存储类（真实集群写操作，cluster-scoped 资源需 admin）。
// 仅当显式 ?cluster= 时创建到真实 K8s；未选集群直接返回明确错误，避免静默写入本地 DB mock。
func (h *Handler) CreateStorageClass(c *gin.Context) {
	var sc model.StorageClass
	if err := c.ShouldBindJSON(&sc); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	cid, ok := h.clusterIDOrFallback(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请先选择集群（StorageClass 为 cluster-scoped 资源，需在真实集群创建）"})
		return
	}
	out, err := h.K8s.CreateStorageClass(cid, sc)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, out)
}

// PVCs 持久化卷声明
// 策略：?cluster= → 真实 K8s（所有命名空间）；未带 cluster 参数 → 回退 DB。
func (h *Handler) PVCs(c *gin.Context) {
	if cid, ok := h.clusterIDOrFallback(c); ok {
		list, err := h.K8s.PVCs(cid)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, list)
		return
	}
	list, _ := h.Store.PVCs()
	c.JSON(http.StatusOK, list)
}

// CreatePVC 创建持久卷声明（真实集群写操作）。
// 仅当显式 ?cluster= 时创建到真实 K8s；未选集群直接返回明确错误，避免静默写入本地 DB mock。
func (h *Handler) CreatePVC(c *gin.Context) {
	var p model.PVC
	if err := c.ShouldBindJSON(&p); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	cid, ok := h.clusterIDOrFallback(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请先选择集群（PVC 需在真实集群创建）"})
		return
	}
	out, err := h.K8s.CreatePVC(cid, p)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, out)
}

// CreatePV 新建持久卷（真实集群写操作，cluster-scoped 资源需 admin）。
// 仅当显式 ?cluster= 时创建到真实 K8s；PV 无本地 DB 模型，未选集群直接返回明确错误。
func (h *Handler) CreatePV(c *gin.Context) {
	var in model.PersistentVolumeInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	cid, ok := h.clusterIDOrFallback(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请先选择集群（PersistentVolume 为 cluster-scoped 资源，需在真实集群创建）"})
		return
	}
	out, err := h.K8s.CreatePV(cid, in)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, out)
}

// StorageSummary 存储 KPI 汇总（真实集群：SC/PV/PVC 数 + 绑定率 + 总容量；非真实集群返回 502）。
func (h *Handler) StorageSummary(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	info, err := h.K8s.StorageSummary(cid)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, info)
}

// PVs 列出集群所有 PersistentVolume（真实集群）；无 ?cluster= 时返回 502（与核心只读策略一致）。
func (h *Handler) PVs(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	list, err := h.K8s.PVs(cid)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, list)
}

// StorageClassDetail 返回单个 SC 的完整 K8s 对象（含 parameters/annotations/YAML）。
func (h *Handler) StorageClassDetail(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	name := c.Param("name")
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 name 参数"})
		return
	}
	d, err := h.K8s.StorageClassDetail(cid, name)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, d)
}

// PVDetail 返回单个 PV 的完整信息（含 source 子类型原始字段 / YAML）。
func (h *Handler) PVDetail(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	name := c.Param("name")
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 name 参数"})
		return
	}
	d, err := h.K8s.PVDetail(cid, name)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, d)
}

// PVCDetail 返回单个 PVC 的完整信息（含 YAML）。
func (h *Handler) PVCDetail(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	ns := c.Param("ns")
	name := c.Param("name")
	if ns == "" || name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 ns/name 参数"})
		return
	}
	d, err := h.K8s.PVCDetail(cid, ns, name)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, d)
}

// UpdateStorageClass 修改 SC（仅 parameters/annotations 可改；K8s provisioner/reclaimPolicy/volumeBindingMode 不可改）。
func (h *Handler) UpdateStorageClass(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	name := c.Param("name")
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 name 参数"})
		return
	}
	var in k8s.SCUpdate
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	d, err := h.K8s.UpdateStorageClass(cid, name, in)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, d)
}

// UpdatePV 修改 PV（仅 reclaimPolicy/annotations 可改）。
func (h *Handler) UpdatePV(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	name := c.Param("name")
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 name 参数"})
		return
	}
	var in k8s.PVUpdate
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	d, err := h.K8s.UpdatePV(cid, name, in)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, d)
}

// UpdatePVC 修改 PVC（仅扩缩容 resources.requests.storage；不能缩，向下兼容 K8s 限制）。
func (h *Handler) UpdatePVC(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	ns := c.Param("ns")
	name := c.Param("name")
	if ns == "" || name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 ns/name 参数"})
		return
	}
	var in k8s.PVCUpdate
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	d, err := h.K8s.UpdatePVC(cid, ns, name, in)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, d)
}

// DeletePVC 删除 PVC（仅真实集群；带 ns/name 双段路径）。
func (h *Handler) DeletePVC(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	ns := c.Param("ns")
	name := c.Param("name")
	if ns == "" || name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 ns/name 参数"})
		return
	}
	if err := h.K8s.DeletePVC(cid, ns, name); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// DeletePV 删除 PV（仅真实集群；cluster-scoped）。
func (h *Handler) DeletePV(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	name := c.Param("name")
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 name 参数"})
		return
	}
	if err := h.K8s.DeletePV(cid, name); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// DeleteStorageClass 删除 StorageClass（仅真实集群；cluster-scoped）。
func (h *Handler) DeleteStorageClass(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	name := c.Param("name")
	if name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 name 参数"})
		return
	}
	if err := h.K8s.DeleteStorageClass(cid, name); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// Services 服务
// 策略：?cluster= → 真实 K8s（所有命名空间）；未带 cluster 参数 → 回退 DB（demo 模式）。
func (h *Handler) Services(c *gin.Context) {
	if cid, ok := h.clusterIDOrFallback(c); ok {
		list, err := h.K8s.Services(cid)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, list)
		return
	}
	list, _ := h.Store.Services()
	c.JSON(http.StatusOK, list)
}

// CreateService 创建 Service（必须真实集群）
func (h *Handler) CreateService(c *gin.Context) {
	var in model.ServiceInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	cid, ok := h.clusterIDOrFallback(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请先选择集群（Service 需在真实集群创建）"})
		return
	}
	out, err := h.K8s.CreateService(cid, in)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, out)
}

// Ingresses 路由
// 策略：?cluster= → 真实 K8s（所有命名空间）；未带 cluster 参数 → 回退 DB（demo 模式）。
func (h *Handler) Ingresses(c *gin.Context) {
	if cid, ok := h.clusterIDOrFallback(c); ok {
		list, err := h.K8s.Ingresses(cid)
		if err != nil {
			c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
			return
		}
		c.JSON(http.StatusOK, list)
		return
	}
	list, _ := h.Store.Ingresses()
	c.JSON(http.StatusOK, list)
}

// CreateIngress 创建 Ingress 路由（必须真实集群）
func (h *Handler) CreateIngress(c *gin.Context) {
	var in model.IngressInput
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	cid, ok := h.clusterIDOrFallback(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请先选择集群（Ingress 需在真实集群创建）"})
		return
	}
	out, err := h.K8s.CreateIngress(cid, in)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, out)
}

// GenerateIngressTLSCert 为给定 host 生成自签名证书，落进真实集群 K8s Secret，
// 同时把该凭证登记进「代码凭证」库（Credential 表，type=TLS）。
// 返回 {secretName, credentialId}；证书可经 /api/ingresses 创建时引用。
func (h *Handler) GenerateIngressTLSCert(c *gin.Context) {
	var body struct {
		Host      string `json:"host"`
		Namespace string `json:"namespace"`
	}
	if err := c.ShouldBindJSON(&body); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	cid, ok := h.clusterIDOrFallback(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请先选择集群"})
		return
	}
	if body.Host == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "域名(host)不能为空"})
		return
	}
	ns := body.Namespace
	if ns == "" {
		ns = "default"
	}
	secretName, err := h.K8s.GenerateIngressTLS(cid, ns, body.Host)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	cred := model.Credential{
		Name:      secretName,
		Type:      "TLS",
		Scope:     "全局",
		SecretRef: "secret/" + secretName,
		CreatedBy: "admin",
		LastUsed:  "刚刚",
		Status:    "ok",
	}
	if err := h.Store.CreateCredential(&cred); err != nil {
		// 集群 Secret 已创建，仅凭证登记失败：返回 warning，仍给出 secretName 供使用
		c.JSON(http.StatusCreated, gin.H{
			"secretName":  secretName,
			"credentialId": 0,
			"warning":      "证书 Secret 已创建，但凭证登记失败: " + err.Error(),
		})
		return
	}
	c.JSON(http.StatusCreated, gin.H{
		"secretName":   secretName,
		"credentialId": cred.ID,
	})
}

// DeleteService 删除 Service（必须真实集群，带 ns/name 双段）
func (h *Handler) DeleteService(c *gin.Context) {
	cid, ok := h.clusterIDOrFallback(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请先选择集群"})
		return
	}
	ns := c.Param("ns")
	name := c.Param("name")
	if ns == "" || name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 ns/name 参数"})
		return
	}
	if err := h.K8s.DeleteService(cid, ns, name); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// DeleteIngress 删除 Ingress（必须真实集群，带 ns/name 双段）
func (h *Handler) DeleteIngress(c *gin.Context) {
	cid, ok := h.clusterIDOrFallback(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请先选择集群"})
		return
	}
	ns := c.Param("ns")
	name := c.Param("name")
	if ns == "" || name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 ns/name 参数"})
		return
	}
	if err := h.K8s.DeleteIngress(cid, ns, name); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// UpdateService 修改 Service（selector/annotations，必须真实集群）
func (h *Handler) UpdateService(c *gin.Context) {
	cid, ok := h.clusterIDOrFallback(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请先选择集群"})
		return
	}
	ns := c.Param("ns")
	name := c.Param("name")
	if ns == "" || name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 ns/name 参数"})
		return
	}
	var up model.ServiceUpdate
	if err := c.ShouldBindJSON(&up); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	out, err := h.K8s.UpdateService(cid, ns, name, up)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, out)
}

// UpdateIngress 修改 Ingress（path/backend/tls，必须真实集群）
func (h *Handler) UpdateIngress(c *gin.Context) {
	cid, ok := h.clusterIDOrFallback(c)
	if !ok {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请先选择集群"})
		return
	}
	ns := c.Param("ns")
	name := c.Param("name")
	if ns == "" || name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "缺少 ns/name 参数"})
		return
	}
	var up model.IngressUpdate
	if err := c.ShouldBindJSON(&up); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	out, err := h.K8s.UpdateIngress(cid, ns, name, up)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, out)
}

// CreateRepo 创建镜像仓库
func (h *Handler) CreateRepo(c *gin.Context) {
	var r model.Repo
	if err := c.ShouldBindJSON(&r); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	r.Favorite, r.Tags, r.Size, r.Pulls, r.LastPush = false, 0, "—", 0, "刚刚"
	if err := h.Store.CreateRepo(&r); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, r)
}

// probeCluster 实时探测单个集群的连通性，并更新 cl 的 connected/health/version 字段。
// 成功后把 connected 持久化到 DB，失败时同样更新为 false，保证各接口读取的 DB 状态一致。
func (h *Handler) probeCluster(cl *model.Cluster) {
	if cl.KubeConfig == "" {
		cl.Health = "no-kubeconfig"
		cl.HealthMessage = "尚未粘贴 KubeConfig"
		cl.Connected = false
		return
	}
	cs, cErr := h.K8s.Clientset(cl.ID)
	if cErr != nil {
		msg := cErr.Error()
		cl.Health = classifyProbeError(msg)
		cl.HealthMessage = msg
		cl.Connected = false
		return
	}
	// 探测成功：尝试拿真实 K8s 版本（拨号失败不致命）
	if v, err := serverVersion(cs); err == nil {
		cl.ClusterVersion = v
		cl.Connected = true
		cl.Health = "ready"
		cl.HealthMessage = ""
	} else {
		cl.Health = "connect-error"
		cl.HealthMessage = "kubeconfig 可解析但 apiserver 不可达：" + err.Error()
		cl.Connected = false
	}
}

// Clusters 集群列表（多集群），并实时探测连通性：
//   - connected+version：能成功 dial apiserver 并拿到 discovery version
//   - health="parse-error" / "connect-error" / "no-kubeconfig"：探测失败，healthMessage 给出真实原因
func (h *Handler) Clusters(c *gin.Context) {
	list, err := h.Store.Clusters()
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	for i := range list {
		cl := &list[i]
		h.probeCluster(cl)
		// 持久化 connected 状态，使 /clusters/me 等接口能看到实时结果
		if err := h.Store.DB.Model(cl).Update("connected", cl.Connected).Error; err != nil {
			// 持久化失败不影响本次返回，仅记录
			_ = err
		}
	}
	c.JSON(http.StatusOK, list)
}

// classifyProbeError 把探测失败归类为前端可识别状态
func classifyProbeError(msg string) string {
	switch {
	case strings.Contains(msg, "尚未配置 KubeConfig"):
		return "no-kubeconfig"
	case strings.Contains(msg, "kubeconfig 解析失败"),
		strings.Contains(msg, "yaml:"),
		strings.Contains(msg, "could not find expected"):
		return "parse-error"
	default:
		return "connect-error"
	}
}

// serverVersion 用 discovery client 拿真实版本（短超时，避免阻塞列表）
func serverVersion(cs *kubernetes.Clientset) (string, error) {
	v, err := cs.Discovery().ServerVersion()
	if err != nil {
		return "", err
	}
	return v.GitVersion, nil
}

// CreateCluster 注册集群（粘贴 KubeConfig）
func (h *Handler) CreateCluster(c *gin.Context) {
	var in struct {
		Name       string `json:"name"`
		Provider   string `json:"provider"`
		Region     string `json:"region"`
		KubeConfig string `json:"kubeConfig"`
		Context    string `json:"context"`
	}
	if err := c.ShouldBindJSON(&in); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	if in.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "集群名称不能为空"})
		return
	}
	if in.KubeConfig == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "KubeConfig 不能为空"})
		return
	}
	cl := model.Cluster{
		Name:       in.Name,
		Provider:   in.Provider,
		Region:     in.Region,
		KubeConfig: in.KubeConfig,
		Context:    in.Context,
	}
	if err := h.Store.CreateCluster(&cl); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.K8s.ClearCache(cl.ID)
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditClusterRegister, "cluster", cl.Name, cl.ID, "ok", "provider="+cl.Provider+" region="+cl.Region)
	c.JSON(http.StatusCreated, cl) // KubeConfig/Context 因 json:"-" 不回传前端
}

// DeleteCluster 删除已注册集群（含 K8s 客户端缓存）
func (h *Handler) DeleteCluster(c *gin.Context) {
	id, err := strconv.ParseUint(c.Param("id"), 10, 64)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "invalid id"})
		return
	}
	var cl *model.Cluster
	if list, _ := h.Store.Clusters(); len(list) > 0 {
		for _, x := range list {
			if x.ID == uint(id) {
				cl = &x
				break
			}
		}
	}
	if err := h.Store.DeleteCluster(uint(id)); err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	h.K8s.ClearCache(uint(id))
	name := ""
	if cl != nil {
		name = cl.Name
	}
	audit.RecordFromCtx(c, h.Store, audit.ActorFrom(c), model.AuditClusterDelete, "cluster", name, uint(id), "ok", "")
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// WorkloadPods 列出某工作负载下的真实 Pod 与容器（供详情抽屉展示与日志/控制台入口）。
func (h *Handler) WorkloadPods(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	ns, name, kind := c.Query("ns"), c.Query("name"), c.Query("kind")
	if name == "" || kind == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name 与 kind 必填"})
		return
	}
	pods, rollout, err := h.K8s.PodsForWorkload(cid, ns, name, kind)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"pods": pods, "rollout": rollout})
}

// WorkloadRevisions 返回工作负载的发布历史与（Deployment 的）暂停状态，
// 供前端“回滚”弹窗选择版本及“暂停/恢复”按钮文案判断。
func (h *Handler) WorkloadRevisions(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	ns, name, kind := c.Query("ns"), c.Query("name"), c.Query("kind")
	if name == "" || kind == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name 与 kind 必填"})
		return
	}
	revs, paused, e := h.K8s.WorkloadRevisions(cid, ns, name, kind)
	if e != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": e.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"revisions": revs, "paused": paused})
}

// WorkloadAction 对工作负载执行写操作：pause/resume/restart/upgrade/rollback。
// 经真实集群执行（strategic merge patch / controllerrevision 回滚）。
func (h *Handler) WorkloadAction(c *gin.Context) {
	var body struct {
		Cluster string         `json:"cluster"`
		Ns      string         `json:"ns"`
		Name    string         `json:"name"`
		Kind    string         `json:"kind"`
		Action  string         `json:"action"`
		Payload map[string]any `json:"payload"`
	}
	if e := c.ShouldBindJSON(&body); e != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请求体解析失败: " + e.Error()})
		return
	}
	// 集群 id 允许来自 query 或 body，避免写操作误落到 DB 里的第一个集群
	cid, err := h.clusterIDWith(c, body.Cluster)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	if body.Name == "" || body.Kind == "" || body.Action == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "name/kind/action 必填"})
		return
	}
	if body.Payload == nil {
		body.Payload = map[string]any{}
	}
	if e := h.K8s.ActionWorkload(cid, body.Ns, body.Name, body.Kind, body.Action, body.Payload); e != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": e.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// WorkloadSpec 读取工作负载“可编辑项”快照（副本数 + 主容器字段），供编辑弹窗预填。
func (h *Handler) WorkloadSpec(c *gin.Context) {
	cid, err := h.clusterIDWith(c, "")
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	kind := c.Query("kind")
	if kind == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "kind 必填"})
		return
	}
	spec, e := h.K8s.GetWorkloadSpec(cid, c.Param("ns"), c.Param("name"), kind)
	if e != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": e.Error()})
		return
	}
	c.JSON(http.StatusOK, spec)
}

// UpdateWorkload 写回工作负载“可编辑项”（副本数 + 主容器字段），作用于真实集群。
func (h *Handler) UpdateWorkload(c *gin.Context) {
	cid, err := h.clusterIDWith(c, "")
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	kind := c.Query("kind")
	if kind == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "kind 必填"})
		return
	}
	var spec k8s.EditableSpec
	if e := c.ShouldBindJSON(&spec); e != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "请求体解析失败: " + e.Error()})
		return
	}
	if spec.Container.Name == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "container.name 必填"})
		return
	}
	if e := h.K8s.UpdateWorkloadSpec(cid, c.Param("ns"), c.Param("name"), kind, &spec); e != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": e.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ok": true})
}

// WorkloadYAML 返回工作负载完整 YAML 清单（含 apiVersion/kind/metadata/spec/status）。
func (h *Handler) WorkloadYAML(c *gin.Context) {
	cid, err := h.clusterIDWith(c, "")
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	kind := c.Query("kind")
	if kind == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "kind 必填"})
		return
	}
	out, e := h.K8s.GetWorkloadYAML(cid, c.Param("ns"), c.Param("name"), kind)
	if e != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": e.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"yaml": out})
}

// PodLogs 以 chunked 流返回 Pod 日志（支持 tail 限行与 follow 实时追加）。
// 前端用 fetch + ReadableStream 消费，零额外依赖。
func (h *Handler) PodLogs(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	ns, pod, container := c.Query("ns"), c.Query("pod"), c.Query("container")
	if pod == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "pod 必填"})
		return
	}
	tail := int64(0)
	if t := c.Query("tail"); t != "" {
		if v, e := strconv.ParseInt(t, 10, 64); e == nil {
			tail = v
		}
	}
	follow := c.Query("follow") == "true"
	rc, err := h.K8s.PodLogs(cid, ns, pod, container, tail, follow)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	defer rc.Close()

	hdr := c.Writer.Header()
	hdr.Set("Content-Type", "text/plain; charset=utf-8")
	hdr.Set("Cache-Control", "no-cache")
	hdr.Set("Connection", "keep-alive")
	hdr.Set("X-Accel-Buffering", "no")
	c.Writer.WriteHeader(http.StatusOK)
	c.Writer.Flush()

	buf := make([]byte, 4096)
	for {
		n, e := rc.Read(buf)
		if n > 0 {
			if _, wErr := c.Writer.Write(buf[:n]); wErr != nil {
				return
			}
			c.Writer.Flush()
		}
		if e != nil {
			return
		}
	}
}

// PodExec 通过 WebSocket 桥接 kubectl exec（TTY 交互式终端）。
// 前端用 xterm 渲染，stdin 以 binary 帧发送，resize 以 text(JSON) 帧发送。
func (h *Handler) PodExec(c *gin.Context) {
	cid, err := h.clusterID(c)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	ns, pod, container := c.Query("ns"), c.Query("pod"), c.Query("container")
	command := c.Query("command")
	if command == "" {
		command = "/bin/sh"
	}
	if pod == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "pod 必填"})
		return
	}
	exec, err := h.K8s.PodExec(cid, ns, pod, container, command)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}

	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// 预置默认终端尺寸，避免 TTY 模式下 TerminalSizeQueue.Next() 因等待首个
	// resize 而长时间阻塞（client-go 在独立 goroutine 中调用 Next()，不阻塞 stdin，
	// 但预置尺寸可让终端在客户端尚未发送 resize 时即拥有合理默认大小）。
	sizeCh := make(chan remotecommand.TerminalSize, 16)
	sizeCh <- remotecommand.TerminalSize{Width: 80, Height: 24}
	reader := &wsExecReader{conn: conn, sizeCh: sizeCh}
	writer := &wsExecWriter{conn: conn}

	go func() {
		_ = exec.StreamWithContext(ctx, remotecommand.StreamOptions{
			Stdin:             reader,
			Stdout:            writer,
			Stderr:            writer,
			Tty:               true,
			TerminalSizeQueue: &wsSizeQueue{ch: sizeCh},
		})
		cancel()
	}()

	<-ctx.Done()
}

// ---------- WebSocket ↔ exec 流适配器 ----------

// wsExecReader 将 WebSocket 消息适配为 exec 的 io.Reader：
// binary 帧视为 stdin 数据；text(JSON) 帧视为 resize 控制消息。
type wsExecReader struct {
	conn   *websocket.Conn
	sizeCh chan remotecommand.TerminalSize
}

func (r *wsExecReader) Read(p []byte) (int, error) {
	for {
		mt, data, err := r.conn.ReadMessage()
		if err != nil {
			return 0, err
		}
		if mt == websocket.TextMessage {
			var msg struct {
				Type string `json:"type"`
				Cols uint16 `json:"cols"`
				Rows uint16 `json:"rows"`
			}
			if jErr := json.Unmarshal(data, &msg); jErr == nil && msg.Type == "resize" {
				// 非阻塞发送：sizeCh 缓冲 16，正常情况下不会满；极端情况下丢弃一次
				// resize 也不影响功能（下次 resize 或客户端重连会重新同步尺寸）。
				select {
				case r.sizeCh <- remotecommand.TerminalSize{Width: msg.Cols, Height: msg.Rows}:
				default:
				}
				continue
			}
			return copy(p, data), nil
		}
		return copy(p, data), nil
	}
}

// wsExecWriter 将 exec 的输出适配为 WebSocket binary 帧。
type wsExecWriter struct {
	conn *websocket.Conn
}

func (w *wsExecWriter) Write(p []byte) (int, error) {
	if err := w.conn.WriteMessage(websocket.BinaryMessage, p); err != nil {
		return 0, err
	}
	return len(p), nil
}

// wsSizeQueue 实现 remotecommand.TerminalSizeQueue，供 TTY resize 通知。
type wsSizeQueue struct {
	ch chan remotecommand.TerminalSize
}

func (q *wsSizeQueue) Next() *remotecommand.TerminalSize {
	s, ok := <-q.ch
	if !ok {
		return nil
	}
	return &s
}
