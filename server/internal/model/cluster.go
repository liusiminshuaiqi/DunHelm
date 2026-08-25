package model

// Cluster 集群元信息（单行）
// 多集群模式下：Name/Provider/Region 为注册信息（来自 DB）；
// Nodes/Pods/CpuUsed 等汇总在对接真实集群后由后端实时计算覆盖。
// KubeConfig/Context 仅服务端使用，不返回前端避免敏感信息泄露。
type Cluster struct {
	ID        uint   `gorm:"primarykey" json:"id"`
	Name      string `json:"name"`
	Version   string `json:"version"`
	Provider  string `json:"provider"`
	Region    string `json:"region"`
	Nodes     int    `json:"nodes"`
	Pods      int    `json:"pods"`
	CpuUsed   int    `json:"cpuUsed"`
	CpuTotal  int    `json:"cpuTotal"`
	MemUsed   int    `json:"memUsed"`
	MemTotal  int    `json:"memTotal"`
	KubeConfig string `gorm:"type:text" json:"-"`
	Context    string `gorm:"type:text" json:"-"`
	Connected  bool   `json:"connected"`
	// Health 状态（detail）— 仅后端探测时填，前端据此判断何时高亮"未连接"
	// "ready" / "no-kubeconfig" / "parse-error" / "connect-error"
	Health string `gorm:"-" json:"health,omitempty"`
	// HealthMessage 详细错误（仅 health != ready 时返回），方便排查但不泄露 KubeConfig 内容。
	HealthMessage string `gorm:"-" json:"healthMessage,omitempty"`
	// Version 信息（connected 时探测得到），用于前端"版本"列展示真实 K8s 版本。
	ClusterVersion string `gorm:"-" json:"version,omitempty"`
}

// Namespace 命名空间配额
type Namespace struct {
	ID   uint   `gorm:"primarykey" json:"id"`
	Name string `json:"name"`
	Cpu  int    `json:"cpu"`
	Mem  int    `json:"mem"`
	Pods int    `json:"pods"`
}

// Event 集群事件流
type Event struct {
	ID     uint   `gorm:"primarykey" json:"id"`
	Time   string `json:"time"`
	Type   string `json:"type"`
	Reason string `json:"reason"`
	Obj    string `json:"obj"`
	Msg    string `json:"msg"`
}
