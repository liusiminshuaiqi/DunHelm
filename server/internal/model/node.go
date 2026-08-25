package model

// Node 集群节点
type Node struct {
	ID       uint   `gorm:"primarykey" json:"id"`
	Name     string `json:"name"`
	Role     string `json:"role"` // control-plane | worker
	Status   string `json:"status"`
	Cpu       int    `json:"cpu"`
	Mem       int    `json:"mem"`
	Disk      int    `json:"disk"`       // 兼容字段：= DiskRoot（根磁盘 / 使用率 %）
	DiskRoot      int    `json:"diskRoot"`      // 根磁盘 (/) 使用率 %
	DiskData      int    `json:"diskData"`      // 数据盘 (/data) 使用率 %
	DiskDataFound bool   `json:"diskDataFound"` // 节点是否存在 /data 挂载点（false=无此挂载，非 0% 使用）
	DiskReady     bool   `json:"diskReady"`     // node-exporter 是否已就绪（能取到磁盘指标）
	Pods      int    `json:"pods"`
	PodTotal int    `json:"podTotal"`
	Version  string `json:"version"`
	IP       string `json:"ip"`
	OS       string `json:"os"`
	Kubelet  string `json:"kubelet"`
	Age      string `json:"age"`
}
