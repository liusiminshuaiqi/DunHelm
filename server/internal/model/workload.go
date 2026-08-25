package model

// Workload 工作负载（Deployment / StatefulSet / DaemonSet）
// Kind 字段由后端在 seed 时按前端 typeOf 规则赋值，前端切换 tab 时按该字段过滤
type Workload struct {
	ID        uint        `gorm:"primarykey" json:"id"`
	Name      string      `json:"name"`
	Namespace string      `json:"namespace"`
	Kind      string      `json:"kind"` // deployment | statefulset | daemonset
	Status    string      `json:"status"`
	Desired   int         `json:"desired"`
	Ready     int         `json:"ready"`
	Image     string      `json:"image"`
	Cpu       int         `json:"cpu"` // millicores
	Restarts  int         `json:"restarts"`
	Age       string      `json:"age"`
	Pods      StringSlice `gorm:"type:text" json:"pods"`
	// Labels 是 spec.template.metadata.labels（Pod 模板 labels）。
	// Service Selector 必须匹配 Pod labels，而 Pod labels 来自这里的 Pod template，
	// 因此 Service 自动填 selector 时直接用模板 labels 即可。
	// 不存 DB（gorm:"-"），只用于实时读 K8s 透传给前端。
	Labels map[string]string `gorm:"-" json:"labels,omitempty"`
	// ContainerPorts 是 spec.template.spec.containers[*].ports[*].containerPort。
	// Service 端口映射的 targetPort 通常应等于容器端口；前端「指定工作负载」时
	// 据此把容器端口自动同步进端口映射编辑器（port/targetPort 均填容器端口）。
	// 不存 DB（gorm:"-"），只用于实时读 K8s 透传给前端。
	ContainerPorts []ContainerPort `gorm:"-" json:"containerPorts,omitempty"`
}

// ContainerPort 工作负载容器暴露的端口（供前端同步进 Service 端口映射）。
type ContainerPort struct {
	Port     int32  `json:"port"`
	Protocol string `json:"protocol"`
}
