package k8s

import (
	"context"
	"fmt"
	"strings"

	apierr "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// WorkloadExists 判断指定 kind 的工作负载是否已存在。
// 用于流水线 deploy 阶段做幂等（已存在走 Update，不存在走 Create）。
func (m *Manager) WorkloadExists(cid uint, ns, name, kind string) (bool, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return false, err
	}
	ctx := context.TODO()
	var gerr error
	switch strings.ToLower(kind) {
	case "deployment":
		_, gerr = cs.AppsV1().Deployments(ns).Get(ctx, name, metav1.GetOptions{})
	case "statefulset":
		_, gerr = cs.AppsV1().StatefulSets(ns).Get(ctx, name, metav1.GetOptions{})
	case "daemonset":
		_, gerr = cs.AppsV1().DaemonSets(ns).Get(ctx, name, metav1.GetOptions{})
	case "job":
		_, gerr = cs.BatchV1().Jobs(ns).Get(ctx, name, metav1.GetOptions{})
	case "cronjob":
		_, gerr = cs.BatchV1().CronJobs(ns).Get(ctx, name, metav1.GetOptions{})
	default:
		return false, fmt.Errorf("不支持的工作负载类型: %s", kind)
	}
	if gerr != nil {
		if apierr.IsNotFound(gerr) {
			return false, nil
		}
		return false, gerr
	}
	return true, nil
}

// UpdateWorkloadFromCreate 把 CreateWorkloadReq 的可编辑字段同步到现有工作负载。
// 内部复用 GetWorkloadSpec 拿当前 spec → 改副本数 + 主容器字段 → UpdateWorkloadSpec。
// 注：调度（PriorityClassName / NodeSelector）由 Create 路径下发；Update 路径仅修改可编辑字段，
// 下一次「删除后重建」会按新调度生效。
func (m *Manager) UpdateWorkloadFromCreate(cid uint, ns, name, kind string, req CreateWorkloadReq) error {
	spec, err := m.GetWorkloadSpec(cid, ns, name, kind)
	if err != nil {
		return err
	}
	if req.Replicas > 0 {
		spec.Replicas = req.Replicas
	}
	// 主容器字段映射
	c := &spec.Container
	c.Image = req.Image
	c.CPU = req.CPU
	c.Mem = req.Mem
	c.CPUReq = req.CPUReq
	c.MemReq = req.MemReq
	c.Command = req.Command
	c.Args = req.Args
	c.Env = req.Env
	c.Ports = req.Ports
	c.LivenessProbe = req.LivenessProbe
	c.ReadinessProbe = req.ReadinessProbe
	c.StartupProbe = req.StartupProbe
	return m.UpdateWorkloadSpec(cid, ns, name, kind, spec)
}