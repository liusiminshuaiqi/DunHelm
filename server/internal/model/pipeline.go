package model

import (
	"kubehelm/server/internal/crypto"

	"gorm.io/gorm"
)

// Pipeline CI/CD 流水线定义（Job）
type Pipeline struct {
	ID              uint       `gorm:"primarykey" json:"-"`
	// 归属集群（多集群隔离）：该流水线定义挂在哪个集群下。CI 实际执行集群见 Cluster 字段。
	ClusterID uint `gorm:"index" json:"clusterId"`
	// IsTemplate 标记为公共模板：模板流水线可被其他集群读取（读路径回退），
	// 但写操作（更新/删除/触发）仍严格限定本集群，避免跨集群越权。
	IsTemplate bool `gorm:"index" json:"isTemplate"`
	Name            string     `json:"name"`
	Repo            string     `json:"repo"`
	Branch          string     `json:"branch"`
	LastStatus      string     `json:"lastStatus"`
	Duration        string     `json:"duration"`
	Trigger         string     `json:"trigger"`
	Env             string     `json:"env"`     // 部署环境
	LastRun         string     `json:"lastRun"`
	Stages          StageSlice `gorm:"type:text" json:"stages"` // 阶段定义（name + enabled）
	Spark           IntSlice   `gorm:"type:text" json:"spark"`
	// RecentBuilds 最近 N 次构建的状态（最新在前）。不落 DB（gorm:"-"），仅在 handler.Pipelines 列表接口里运行时填充，
	// 用于流水线卡片上的「构建历史条」可视化（每格 = 一次构建，颜色 = 状态）。
	RecentBuilds    StringSlice `gorm:"-" json:"recentBuilds"`
	// 触发模式：空（兼容旧数据，等同 git）/ git / backend / frontend / image
	TriggerMode string `json:"triggerMode"`
	// 镜像模式默认镜像（用于 image 触发模式快速填充）
	DefaultImage string `json:"defaultImage"`
	// 镜像模式目标命名空间 / 工作负载名（用于 kubectl apply 合成日志）
	TargetNamespace string `json:"targetNamespace"`
	TargetWorkload  string `json:"targetWorkload"`
	// 构建集群（CI 真执行的临时 Pod 跑在哪个集群）：clusterID 字符串，留空则用首个 Connected 集群。
	// 统一在流水线基础信息配置，避免每个节点各配一次。
	Cluster string `json:"cluster"`
	// 容器运行时：docker（默认，依赖 docker daemon）或 podman（daemonless，适合在 K8s Pod 内 build/push）。
	// 选 podman 时引擎会自动用 podman build/podman push，并在执行前按 baseImage 的 OS 检测安装 podman。
	Runtime string `json:"runtime"`
	// 构建模版（决定构建 Pod 的本地依赖缓存挂载方式）：空（兼容旧数据，等同 maven）/ maven（后端，~/.m2）/ npm（前端，npm cacache）。
	// 引擎在创建临时构建 Pod 时按该值选择挂载哪种节点本地盘缓存（方案C），从而让后端 mvn / 前端 npm ci 命中缓存、避免每次重拉包。
	BuilderType string `json:"builderType"`
	// MavenSettings 流水级 Maven settings.xml 内容（servers / 凭证等）。AES-GCM 加密落库；
	// 读出口由 AfterFind 解密（明文），供前端回填与引擎挂载到构建 Pod（/root/.m2/settings.xml）。
	// 注意：UpdatePipeline 走 Updates(map) 不触发 BeforeSave 钩子，加密在 repository 层手动完成；
	// 本钩子覆盖 Create（DB.Create 触发）与直接 Save 路径。
	MavenSettings string `json:"mavenSettings"`
}

// BeforeSave 落库前加密 MavenSettings（DB 仅存密文）。
func (p *Pipeline) BeforeSave(*gorm.DB) error {
	if p.MavenSettings != "" {
		if enc, err := crypto.Encrypt(p.MavenSettings); err == nil {
			p.MavenSettings = enc
		}
	}
	return nil
}

// AfterFind 读取后解密 MavenSettings（失败保留原值，不阻断读取）。
func (p *Pipeline) AfterFind(*gorm.DB) error {
	if p.MavenSettings != "" {
		if dec, err := crypto.Decrypt(p.MavenSettings); err == nil {
			p.MavenSettings = dec
		}
	}
	return nil
}

// BuildSource 单次构建的源信息（依据 TriggerMode 选其一）
type BuildSource struct {
	// git / backend / frontend / image
	TriggerMode string `json:"triggerMode"`
	// git
	Repo   string `json:"repo"`
	Branch string `json:"branch"`
	Commit string `json:"commit,omitempty"`
	// image
	Image string `json:"image,omitempty"`
	// backend 包（后端编译产物）
	ArtifactPath string `json:"artifactPath,omitempty"`
	// frontend 包（前端静态包）
	FrontendPath string `json:"frontendPath,omitempty"`
	// 命名空间 / 工作负载（镜像模式下 kubectl apply 用）
	Namespace string `json:"namespace,omitempty"`
	Workload  string `json:"workload,omitempty"`
}

// Build 一次构建运行（Jenkins 的 Build / Run）
type Build struct {
	ID           uint            `gorm:"primarykey" json:"-"`
	// 归属集群（多集群隔离）：构建记录随其流水线归属集群，列表/清理均按此过滤。
	ClusterID uint `gorm:"index" json:"clusterId"`
	BuildNo      string          `json:"id"`
	PipelineName string          `json:"pipeline"`
	Status       string          `json:"status"` // pending | running | ok | err | aborted
	Branch       string          `json:"branch"`
	Trigger      string          `json:"trigger"`
	Duration     string          `json:"duration"`
	Time         string          `json:"time"`
	Stages       BuildStageSlice `gorm:"type:text" json:"stages"` // 各阶段运行态（含日志）
	// 单次构建的源（git/后端包/前端包/镜像 + 上下文）
	Source BuildSource `gorm:"type:text" json:"source"`
}