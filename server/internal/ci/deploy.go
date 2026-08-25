package ci

import (
	"encoding/json"
	"fmt"
	"strings"

	"kubehelm/server/internal/k8s"
)

// DeployConfig 单条流水线「部署」阶段的配置（stage.Config 反序列化）。
// 字段为前端 EditNodeModal 中 deploy 节点的 configSchema 一一对应（包含 KubeSphere 风格：
// 调度策略 / 命名空间 / 实例数 / 启动命令 / 资源限制+请求 / 端口 / 数据卷 / 健康检查 等）。
// 复杂嵌套（env / ports / volumes / probes）以 JSON 字符串形式存于 *_json 字段。
type DeployConfig struct {
	Kind         string `json:"kind"`           // Deployment | StatefulSet | DaemonSet | Job | CronJob
	Name         string `json:"name"`           // 工作负载名称
	Namespace    string `json:"namespace"`      // 目标命名空间
	CustomNS     bool   `json:"customNamespace,omitempty"`
	Replicas     string `json:"replicas"`       // 字符串便于绑定 input；解析后转 int32
	Image        string `json:"image"`
	Command      string `json:"command"`        // 启动命令（空格分隔）
	Args         string `json:"args"`           // 启动参数（空格分隔）
	CPU          string `json:"cpu"`            // 资源限制 CPU（毫核）
	Mem          string `json:"mem"`            // 资源限制 内存
	CPUReq       string `json:"cpuReq"`         // 资源请求 CPU
	MemReq       string `json:"memReq"`         // 资源请求 内存
	Schedule     string `json:"schedule"`       // CronJob 专用
	Priority     string `json:"priority"`       // Pod PriorityClassName（"Normal"→空，其他原样下发）
	MaxEviction  bool   `json:"maxEviction,omitempty"`
	NodeSelector string `json:"nodeSelector_json"` // JSON 对象字符串：{"zone":"a"}
	Tolerations  string `json:"tolerations"`    // 预留，v1 不下发
	EnvJSON      string `json:"env_json"`
	PortsJSON    string `json:"ports_json"`
	VolumesJSON  string `json:"volumes_json"`
	ProbesJSON   string `json:"probes_json"`
	MonPerf      bool   `json:"monitoring_perf,omitempty"`
	MonHubble    bool   `json:"monitoring_hubble,omitempty"`
	MonJVM       bool   `json:"monitoring_jvm,omitempty"`
	MonJacoco    bool   `json:"monitoring_jacoco,omitempty"`
}

// DeployResult 部署执行结果（用于 stage 日志里拼接真实 K8s 输出）。
type DeployResult struct {
	LogLines []string
	Created  bool   // true=Create；false=Update（已存在则更新）
	Kind     string // 实际下发的资源 kind（Deployment / StatefulSet / ...）
	Name     string
	NS       string
}

// RunDeploy 解析 deploy 阶段 config，真实下发到集群；返回进度日志行（每行一条）。
// 幂等：若同名资源已存在，走 Update 路径；否则 Create。
// fallbackImage 是上游兜底值（来自流水线 defaultImage 或触发源）。
func (e *Engine) RunDeploy(stageConfig string, fallbackImage string) (*DeployResult, error) {
	res := &DeployResult{}
	cfg, perr := parseDeployConfig(stageConfig)
	if perr != nil {
		return res, fmt.Errorf("deploy 配置解析失败: %w", perr)
	}
	// 兜底值
	if strings.TrimSpace(cfg.Image) == "" {
		cfg.Image = fallbackImage
	}
	if strings.TrimSpace(cfg.Image) == "" {
		return res, fmt.Errorf("镜像为空：请在 deploy 节点的「镜像」字段填写或选择镜像")
	}
	if strings.TrimSpace(cfg.Kind) == "" {
		cfg.Kind = "Deployment"
	}
	// 归一化为小写：前端 deploy 节点按 KubeSphere 风格传首字母大写的 "Deployment"，
	// 而 k8s 层所有 kind 分发（GetWorkloadSpec/CreateWorkload/...）都按小写 "deployment" 匹配；
	// 不归一化会命中不到 switch 分支，报「不支持的工作负载类型: Deployment」。
	cfg.Kind = strings.ToLower(strings.TrimSpace(cfg.Kind))
	if strings.TrimSpace(cfg.Name) == "" {
		cfg.Name = deriveDeployName(cfg.Image)
	}
	if strings.TrimSpace(cfg.Namespace) == "" {
		cfg.Namespace = "default"
	}
	res.Kind = cfg.Kind
	res.Name = cfg.Name
	res.NS = cfg.Namespace

	// 选集群：取第一个已注册且有 KubeConfig 的集群（多集群场景下默认部署到第一个可用集群）。
	clusters, err := e.store.Clusters()
	if err != nil || len(clusters) == 0 {
		return res, fmt.Errorf("未找到已注册集群：请先在「集群」页登记 KubeConfig")
	}
	var cid uint
	var chosenName string
	for _, cl := range clusters {
		if cl.KubeConfig != "" {
			cid = cl.ID
			chosenName = cl.Name
			break
		}
	}
	if cid == 0 {
		return res, fmt.Errorf("所有已注册集群都未配置 KubeConfig：请先在「集群」页粘贴 KubeConfig")
	}
	res.LogLines = append(res.LogLines, fmt.Sprintf("$ target cluster = #%d (%s)", cid, chosenName))

	req, merr := buildCreateReq(cfg)
	if merr != nil {
		return res, merr
	}

	exists, lerr := e.k8s.WorkloadExists(cid, cfg.Namespace, cfg.Name, cfg.Kind)
	if lerr != nil {
		return res, lerr
	}
	lowKind := strings.ToLower(cfg.Kind)
	if exists {
		res.LogLines = append(res.LogLines, fmt.Sprintf("$ kubectl set / patch %s/%s -n %s", lowKind, cfg.Name, cfg.Namespace))
		if err := e.k8s.UpdateWorkloadFromCreate(cid, cfg.Namespace, cfg.Name, cfg.Kind, req); err != nil {
			return res, err
		}
		res.Created = false
		res.LogLines = append(res.LogLines, fmt.Sprintf("%s.apps/%s configured", lowKind, cfg.Name))
		res.LogLines = append(res.LogLines, fmt.Sprintf("deployment \"%s\" successfully rolled out", cfg.Name))
	} else {
		res.LogLines = append(res.LogLines, fmt.Sprintf("$ kubectl apply -f %s.yaml -n %s", cfg.Name, cfg.Namespace))
		if err := e.k8s.CreateWorkload(cid, req); err != nil {
			return res, err
		}
		res.Created = true
		res.LogLines = append(res.LogLines, fmt.Sprintf("%s.apps/%s created", lowKind, cfg.Name))
	}
	return res, nil
}

// parseDeployConfig 解析 stage.Config JSON；空串返回空 struct（将走兜底）。
func parseDeployConfig(s string) (DeployConfig, error) {
	var c DeployConfig
	if strings.TrimSpace(s) == "" {
		return c, nil
	}
	if err := json.Unmarshal([]byte(s), &c); err != nil {
		return c, err
	}
	return c, nil
}

// buildCreateReq 把扁平 DeployConfig → k8s.CreateWorkloadReq（含 env/ports/volumes/probes 解析）。
func buildCreateReq(c DeployConfig) (k8s.CreateWorkloadReq, error) {
	replicas := int32(0)
	if n, err := parseInt32(c.Replicas); err == nil && n > 0 {
		replicas = n
	}
	env, err := parseEnvJSON(c.EnvJSON)
	if err != nil {
		return k8s.CreateWorkloadReq{}, fmt.Errorf("env_json 解析失败: %w", err)
	}
	ports, err := parsePortsJSON(c.PortsJSON)
	if err != nil {
		return k8s.CreateWorkloadReq{}, fmt.Errorf("ports_json 解析失败: %w", err)
	}
	vols, err := parseVolumesJSON(c.VolumesJSON)
	if err != nil {
		return k8s.CreateWorkloadReq{}, fmt.Errorf("volumes_json 解析失败: %w", err)
	}
	liveness, readiness, startup, err := parseProbesJSON(c.ProbesJSON)
	if err != nil {
		return k8s.CreateWorkloadReq{}, fmt.Errorf("probes_json 解析失败: %w", err)
	}
	nodeSelector, err := parseNodeSelectorJSON(c.NodeSelector)
	if err != nil {
		return k8s.CreateWorkloadReq{}, fmt.Errorf("nodeSelector_json 解析失败: %w", err)
	}
	priorityClass := c.Priority
	if priorityClass == "Normal" {
		priorityClass = ""
	}

	return k8s.CreateWorkloadReq{
		Kind:              c.Kind,
		Name:              c.Name,
		Namespace:         c.Namespace,
		Replicas:          replicas,
		Image:             c.Image,
		CPU:               c.CPU,
		Mem:               c.Mem,
		CPUReq:            c.CPUReq,
		MemReq:            c.MemReq,
		Command:           splitShell(c.Command),
		Args:              splitShell(c.Args),
		Schedule:          c.Schedule,
		Env:               env,
		Ports:             ports,
		Volumes:           vols,
		LivenessProbe:     liveness,
		ReadinessProbe:    readiness,
		StartupProbe:      startup,
		PriorityClassName: priorityClass,
		NodeSelector:      nodeSelector,
	}, nil
}

func parseInt32(s string) (int32, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, nil
	}
	var n int32
	_, err := fmt.Sscanf(s, "%d", &n)
	return n, err
}

// splitShell 把空格分隔的字符串切成 tokens（不含引号转义，足够容器命令场景）。
func splitShell(s string) []string {
	s = strings.TrimSpace(s)
	if s == "" {
		return nil
	}
	return strings.Fields(s)
}

func parseEnvJSON(s string) ([]k8s.EnvReq, error) {
	if strings.TrimSpace(s) == "" {
		return nil, nil
	}
	var arr []k8s.EnvReq
	if err := json.Unmarshal([]byte(s), &arr); err != nil {
		return nil, err
	}
	return arr, nil
}

func parsePortsJSON(s string) ([]k8s.PortReq, error) {
	if strings.TrimSpace(s) == "" {
		return nil, nil
	}
	var arr []k8s.PortReq
	if err := json.Unmarshal([]byte(s), &arr); err != nil {
		return nil, err
	}
	return arr, nil
}

func parseVolumesJSON(s string) ([]k8s.VolumeReq, error) {
	if strings.TrimSpace(s) == "" {
		return nil, nil
	}
	var arr []k8s.VolumeReq
	if err := json.Unmarshal([]byte(s), &arr); err != nil {
		return nil, err
	}
	return arr, nil
}

// parseProbesJSON 形如 {"liveness":{...},"readiness":{...},"startup":{...}}。
func parseProbesJSON(s string) (*k8s.ProbeReq, *k8s.ProbeReq, *k8s.ProbeReq, error) {
	if strings.TrimSpace(s) == "" {
		return nil, nil, nil, nil
	}
	var blob struct {
		Liveness  *k8s.ProbeReq `json:"liveness"`
		Readiness *k8s.ProbeReq `json:"readiness"`
		Startup   *k8s.ProbeReq `json:"startup"`
	}
	if err := json.Unmarshal([]byte(s), &blob); err != nil {
		return nil, nil, nil, err
	}
	return blob.Liveness, blob.Readiness, blob.Startup, nil
}

// parseNodeSelectorJSON 把 JSON 对象（字符串键值对）解析为 map[string]string。
func parseNodeSelectorJSON(s string) (map[string]string, error) {
	if strings.TrimSpace(s) == "" {
		return nil, nil
	}
	m := make(map[string]string)
	if err := json.Unmarshal([]byte(s), &m); err != nil {
		return nil, err
	}
	if len(m) == 0 {
		return nil, nil
	}
	return m, nil
}

// deriveDeployName 从镜像名派生默认 workload 名：取最后一段去掉 tag 与 digest。
func deriveDeployName(image string) string {
	last := image
	if i := strings.LastIndex(image, "/"); i >= 0 {
		last = image[i+1:]
	}
	if i := strings.LastIndex(last, ":"); i >= 0 {
		last = last[:i]
	}
	if i := strings.LastIndex(last, "@"); i >= 0 {
		last = last[:i]
	}
	return last
}