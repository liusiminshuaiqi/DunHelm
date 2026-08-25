package k8s

import (
	"context"
	"fmt"
	"sort"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ConfigMapView 是 GetConfigMap 的统一返回：data + binaryData（base64 字符串）+ labels + annotations。
// 简化场景：暂不返回 ownerReferences / managedFields 等元字段；write 流程也只覆盖 data。
type ConfigMapView struct {
	Name        string            `json:"name"`
	Namespace   string            `json:"namespace"`
	Data        map[string]string `json:"data"`
	BinaryData  map[string]string `json:"binaryData"` // k8s 返回 []byte，这里统一 base64 字符串（写场景一般不传）
	Labels      map[string]string `json:"labels"`
	Annotations map[string]string `json:"annotations"`
}

// ConfigMapSummary 是 ListConfigMaps 的轻量返回（列表视图用）：name + key 数量 + data 总字节数。
type ConfigMapSummary struct {
	Name     string `json:"name"`
	KeyCount int    `json:"keyCount"`
	DataBytes int64 `json:"dataBytes"`
}

// GetConfigMap 从指定集群读取指定命名空间下的 ConfigMap。
//   - 不存在返 NotFound 错误（IsNotFound(err) 为 true）。
//   - 集群未注册 / clientset 获取失败 → 返回包装错误。
func (m *Manager) GetConfigMap(clusterID uint, namespace, name string) (*ConfigMapView, error) {
	cs, err := m.Clientset(clusterID)
	if err != nil {
		return nil, err
	}
	cm, err := cs.CoreV1().ConfigMaps(namespace).Get(context.Background(), name, metav1.GetOptions{})
	if err != nil {
		return nil, err
	}
	binary := make(map[string]string, len(cm.BinaryData))
	for k, v := range cm.BinaryData {
		binary[k] = string(v)
	}
	// 规范化 nil map → 空 map：K8s 没 labels/annotations/data 时返回 nil map，序列化成 JSON 的 null
	// 前端 Object.keys(null) 会炸 TypeError；统一返回 {} 让前端无脑用。
	return &ConfigMapView{
		Name:        cm.Name,
		Namespace:   cm.Namespace,
		Data:        ensureMap(cm.Data),
		BinaryData:  binary,
		Labels:      ensureMap(cm.Labels),
		Annotations: ensureMap(cm.Annotations),
	}, nil
}

func ensureMap(m map[string]string) map[string]string {
	if m == nil {
		return map[string]string{}
	}
	return m
}

// ListConfigMaps 列出某命名空间下所有 ConfigMap（按 name 排序，仅返回轻量摘要）。
func (m *Manager) ListConfigMaps(clusterID uint, namespace string) ([]ConfigMapSummary, error) {
	cs, err := m.Clientset(clusterID)
	if err != nil {
		return nil, err
	}
	list, err := cs.CoreV1().ConfigMaps(namespace).List(context.Background(), metav1.ListOptions{})
	if err != nil {
		return nil, err
	}
	out := make([]ConfigMapSummary, 0, len(list.Items))
	for _, cm := range list.Items {
		var bytes int64
		for _, v := range cm.Data {
			bytes += int64(len(v))
		}
		out = append(out, ConfigMapSummary{
			Name:      cm.Name,
			KeyCount:  len(cm.Data),
			DataBytes: bytes,
		})
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out, nil
}

// UpsertConfigMap 整体覆盖指定 ConfigMap 的 data 字段（labels / annotations / binaryData 保持不变）。
//   - 已存在 → Update（data 整体替换为新值）
//   - 不存在 → Create（labels / annotations 取自现有或新建；data 用新值）
// data 与 name / namespace 必填；labels / annotations 可选（创建时使用，修改时不动现有 metadata）。
func (m *Manager) UpsertConfigMap(clusterID uint, namespace, name string, data map[string]string, labels, annotations map[string]string) (*ConfigMapView, error) {
	if namespace == "" {
		return nil, fmt.Errorf("namespace 必填")
	}
	if name == "" {
		return nil, fmt.Errorf("name 必填")
	}
	cs, err := m.Clientset(clusterID)
	if err != nil {
		return nil, err
	}
	existing, gerr := cs.CoreV1().ConfigMaps(namespace).Get(context.Background(), name, metav1.GetOptions{})
	if apierrors.IsNotFound(gerr) {
		// 创建
		cm := &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{
				Name:        name,
				Namespace:   namespace,
				Labels:      labels,
				Annotations: annotations,
			},
			Data: data,
		}
		if _, cerr := cs.CoreV1().ConfigMaps(namespace).Create(context.Background(), cm, metav1.CreateOptions{}); cerr != nil {
			return nil, cerr
		}
		return m.GetConfigMap(clusterID, namespace, name)
	}
	if gerr != nil {
		return nil, gerr
	}
	// 更新：data 整体覆盖；labels / annotations 保持原样
	existing.Data = data
	if _, uerr := cs.CoreV1().ConfigMaps(namespace).Update(context.Background(), existing, metav1.UpdateOptions{}); uerr != nil {
		return nil, uerr
	}
	return m.GetConfigMap(clusterID, namespace, name)
}