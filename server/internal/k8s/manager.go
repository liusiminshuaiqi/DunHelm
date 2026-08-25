package k8s

import (
	"fmt"
	"sync"

	"kubehelm/server/internal/model"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
	metrics "k8s.io/metrics/pkg/client/clientset/versioned"
	"gorm.io/gorm"
)

// Manager 管理多集群的 Kubernetes 客户端连接。
// 每个集群的连接信息（kubeconfig 文本）来自 DB 的 Cluster 表，按 cluster id 构建并缓存。
type Manager struct {
	db    *gorm.DB
	mu    sync.Mutex
	cache map[uint]*clusterClients
}

type clusterClients struct {
	cs     *kubernetes.Clientset
	metric *metrics.Clientset
	rest   *rest.Config
}

func NewManager(db *gorm.DB) *Manager {
	return &Manager{db: db, cache: map[uint]*clusterClients{}}
}

// Clientset 返回指定集群的 kubernetes clientset（构建后缓存）。
// 按"直接返回错误"策略：无 kubeconfig / 解析失败 / 建连失败 均返回明确错误，不回退 mock。
func (m *Manager) Clientset(clusterID uint) (*kubernetes.Clientset, error) {
	cc, err := m.client(clusterID)
	if err != nil {
		return nil, err
	}
	return cc.cs, nil
}

// MetricsClient 返回指定集群的 metrics clientset（用于 Node/Pod 真实资源使用率）。
// 集群未安装 metrics-server 时调用方应自行处理错误（使用率降级为 0）。
func (m *Manager) MetricsClient(clusterID uint) (*metrics.Clientset, error) {
	cc, err := m.client(clusterID)
	if err != nil {
		return nil, err
	}
	if cc.metric == nil {
		return nil, fmt.Errorf("集群未初始化 metrics 客户端")
	}
	return cc.metric, nil
}

// RestConfig 返回指定集群的 rest.Config（exec / attach 等需要 SPDY 的操作用）。
func (m *Manager) RestConfig(clusterID uint) (*rest.Config, error) {
	cc, err := m.client(clusterID)
	if err != nil {
		return nil, err
	}
	return cc.rest, nil
}

func (m *Manager) client(clusterID uint) (*clusterClients, error) {
	m.mu.Lock()
	if cc, ok := m.cache[clusterID]; ok {
		m.mu.Unlock()
		return cc, nil
	}
	m.mu.Unlock()

	var c model.Cluster
	if err := m.db.First(&c, clusterID).Error; err != nil {
		return nil, fmt.Errorf("集群 #%d 不存在或未注册", clusterID)
	}
	if c.KubeConfig == "" {
		return nil, fmt.Errorf("集群 %q 尚未配置 KubeConfig，无法连接真实集群（请在集群管理中粘贴 kubeconfig）", c.Name)
	}

	restCfg, err := buildRestConfig(c.KubeConfig, c.Context)
	if err != nil {
		return nil, err
	}

	cs, err := kubernetes.NewForConfig(restCfg)
	if err != nil {
		return nil, fmt.Errorf("集群 %q clientset 创建失败: %w", c.Name, err)
	}
	// metrics 客户端构建失败不致命：仅影响资源使用率展示
	mc, mErr := metrics.NewForConfig(restCfg)
	if mErr != nil {
		mc = nil
	}

	cc := &clusterClients{cs: cs, metric: mc, rest: restCfg}
	m.mu.Lock()
	m.cache[clusterID] = cc
	m.mu.Unlock()
	return cc, nil
}

// buildRestConfig 从 kubeconfig 文本解析 rest.Config，可选指定 context。
func buildRestConfig(kubeconfig, context string) (*rest.Config, error) {
	rawCfg, err := clientcmd.Load([]byte(kubeconfig))
	if err != nil {
		return nil, fmt.Errorf("kubeconfig 解析失败: %w", err)
	}
	var overrides *clientcmd.ConfigOverrides
	if context != "" {
		overrides = &clientcmd.ConfigOverrides{CurrentContext: context}
	}
	clientCfg := clientcmd.NewDefaultClientConfig(*rawCfg, overrides)
	restCfg, err := clientCfg.ClientConfig()
	if err != nil {
		return nil, fmt.Errorf("rest.Config 构建失败: %w", err)
	}
	return restCfg, nil
}

// ClearCache 集群配置变更后清除缓存，下次请求重建连接。
func (m *Manager) ClearCache(clusterID uint) {
	m.mu.Lock()
	delete(m.cache, clusterID)
	m.mu.Unlock()
}
