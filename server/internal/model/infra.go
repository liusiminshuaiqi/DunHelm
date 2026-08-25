package model

// StorageClass 存储类
type StorageClass struct {
	ID          uint   `gorm:"primarykey" json:"-"`
	Name        string `json:"name"`
	Provisioner string `json:"provisioner"`
	Reclaim     string `json:"reclaim"`
	BindMode    string `json:"bindMode"`
	IsDefault   bool   `json:"isDefault"`
	Volumes     int    `json:"volumes"`
}

// PVC 持久化卷声明
type PVC struct {
	ID           uint   `gorm:"primarykey" json:"-"`
	Name         string `json:"name"`
	Namespace    string `json:"namespace"`
	Status       string `json:"status"`
	Capacity     string `json:"capacity"`
	Used         int    `json:"used"`
	StorageClass string `json:"storageClass"`
	Volume       string `json:"volume"`
	Access       string `json:"access"`
	Age          string `json:"age"`
}

// PersistentVolume 持久化卷（K8s cluster-scoped 资源）。
// 字段对齐 K8s core/v1 PersistentVolume 关键展示字段：
//   - Source: 来自 provisioner 的来源（HostPath/NFS/CSI/AWS EBS 等子类型，序列化为字符串）
//   - ClaimRef: 已绑定的 PVC（namespace/name，反向链接）
//   - ReclaimPolicy: Delete/Retain（保留策略，可编辑）
//   - Phase: Available/Bound/Released/Failed（前端状态色调）
type PersistentVolume struct {
	Name          string            `json:"name"`
	Capacity      string            `json:"capacity"`
	StorageClass  string            `json:"storageClass"`
	AccessModes   string            `json:"accessModes"`   // RWO/RWX/ROX 拼接
	Status        string            `json:"status"`        // ok/warn/err/idle（基于 Phase）
	Phase         string            `json:"phase"`         // K8s 原值
	Claim         string            `json:"claim"`         // 已绑定的 PVC：ns/name 或 "—"
	ReclaimPolicy string            `json:"reclaimPolicy"` // Delete/Retain
	Source        string            `json:"source"`        // HostPath/NFS/CSI/AWS EBS…
	Age           string            `json:"age"`
	Labels        map[string]string `json:"labels"`        // 用于详情页与编辑回填
	Annotations   map[string]string `json:"annotations"`
}

// PersistentVolumeInput PV 创建入参（真实集群写操作）。
// 字段比只读的 PersistentVolume 更"工程化"：除基础 name/capacity 外，
// 需要来源类型 (SourceType) 与对应子字段（HostPath/NFS/Local/CSI）。
// Labels/Annotations 可选；StorageClass 留空表示不绑定特定 StorageClass
// （用于那些显式不声明 storageClassName 的 PVC 匹配）。
type PersistentVolumeInput struct {
	Name          string            `json:"name"`
	Capacity      string            `json:"capacity"`
	AccessModes   string            `json:"accessModes"` // RWO/RWX/ROX，逗号分隔
	StorageClass  string            `json:"storageClass"`
	ReclaimPolicy string            `json:"reclaimPolicy"` // Delete/Retain
	SourceType    string            `json:"sourceType"`    // hostPath/nfs/local/csi
	// HostPath
	SourceHostPath string `json:"sourceHostPath"`
	// NFS
	SourceNFSServer string `json:"sourceNFSServer"`
	SourceNFSPath   string `json:"sourceNFSPath"`
	// Local（需要 nodeAffinity 才能被调度；NodeName 可选，设置后写入 required node selector）
	SourceLocalPath string `json:"sourceLocalPath"`
	SourceLocalNode string `json:"sourceLocalNode"`
	// CSI
	SourceCSIDriver       string `json:"sourceCSIDriver"`
	SourceCSIVolumeHandle string `json:"sourceCSIVolumeHandle"`
	SourceCSIFSType       string `json:"sourceCSIFSType"`
	Labels                map[string]string `json:"labels,omitempty"`
	Annotations           map[string]string `json:"annotations,omitempty"`
}

// Service 服务（K8s Service）
type Service struct {
	ID         uint   `gorm:"primarykey" json:"-"`
	Name       string `json:"name"`
	Namespace  string `json:"namespace"`
	Type       string `json:"type"`
	ClusterIP  string `json:"clusterIP"`
	Ports      string `json:"ports"`
	Selector   string `json:"selector"`
	Annotations string `json:"annotations"`
	Status     string `json:"status"`
}

// Ingress 路由规则
type Ingress struct {
	ID        uint   `gorm:"primarykey" json:"-"`
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Host      string `json:"host"`
	Path      string `json:"path"`
	Backend   string `json:"backend"`
	Tls       bool   `json:"tls"`
	Status    string `json:"status"`
}

// ServicePortInput 单个端口映射（创建 / 修改 Service 共用）
// Port=服务暴露端口，TargetPort=容器内部端口（Pod 上实际监听的端口），二者可不同。
type ServicePortInput struct {
	Name       string `json:"name"`       // 可选；多端口或按名引用时必须（如 Ingress backend 按名）
	Port       int    `json:"port"`       // 服务端口（必填，>0）
	TargetPort int    `json:"targetPort"` // 容器内部端口（缺省等于 Port）
	Protocol   string `json:"protocol"`   // TCP / UDP / SCTP，缺省 TCP
}

// ServiceInput 创建 Service 的入参（真实集群写操作）
type ServiceInput struct {
	Name      string             `json:"name"`
	Namespace string             `json:"namespace"`
	Type      string             `json:"type"`     // ClusterIP / NodePort / LoadBalancer
	Ports     []ServicePortInput `json:"ports"`    // 结构化端口列表（支持多端口）
	Selector  string             `json:"selector"` // "app=myapp"
}

// ServiceUpdate 修改 Service 的可变字段。
// K8s 真实约束：Port/TargetPort/Protocol/Name/Type 均可变；仅 ClusterIP 与「已分配的 nodePort」不可变。
// 因此更新时会按 Port 匹配保留原 nodePort，避免 immutable 报错。
type ServiceUpdate struct {
	Selector    map[string]string   `json:"selector"`
	Annotations map[string]string   `json:"annotations"`
	Type        string              `json:"type"`   // ClusterIP / NodePort / LoadBalancer（可变）
	Ports       []ServicePortInput  `json:"ports"`  // 结构化端口列表（可变）
}

// IngressInput 创建 Ingress 的入参（真实集群写操作）
type IngressInput struct {
	Namespace    string `json:"namespace"`
	Host         string `json:"host"`
	Path         string `json:"path"`
	Backend      string `json:"backend"` // "my-svc:8080"
	TLS          bool   `json:"tls"`
	IngressClass string `json:"ingressClass"`
	SecretName   string `json:"secretName"` // TLS 证书 Secret 名；空字符串则不设（沿用旧行为）
}

// IngressUpdate 修改 Ingress 的可变字段（rules 可改）
type IngressUpdate struct {
	Path       string `json:"path"`
	Backend    string `json:"backend"`
	TLS        bool   `json:"tls"`
	SecretName string `json:"secretName"` // TLS 证书 Secret 名；空字符串则不设
}
