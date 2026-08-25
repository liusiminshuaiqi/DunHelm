package k8s

import (
	"context"
	"fmt"
	"sort"
	"strings"

	"kubehelm/server/internal/model"

	corev1 "k8s.io/api/core/v1"
	storagev1 "k8s.io/api/storage/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	apierr "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
)

// ---------- Storage（StorageClass + PVC + PV）真实集群读取 ----------
//
// 设计目标：让 DunHelm 存储卷功能页的数据完全来自真实 K8s 集群（不再走本地 DB mock）。
// StorageClass 是 cluster-scoped（storage.k8s.io/v1），PVC 是 namespaced（core/v1）。
// 与 node-exporter / metrics-server 类似：仅在用户已选真实集群（?cluster=<id>）时启用；
// 未选集群或缺 KubeConfig 时返回明确错误，让前端降级到 mock + 友好提示。
//
// 与 Workloads 的差异：StorageClass 与 PVC 既需要"列出"（实时），又允许"创建"（POST）。
// 创建走真实 K8s（cluster-scoped 资源需要 admin 权限），错误透传。

// StorageClasses 列出集群所有 StorageClass，并统计每个 SC 关联的 PV/PVC 数量
// （用作「卷数」列；K8s 本身不直接给 SC → PV 关联计数，需要扫描所有 PV.Spec.StorageClassName）。
func (m *Manager) StorageClasses(cid uint) ([]model.StorageClass, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	scList, err := cs.StorageV1().StorageClasses().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("列 StorageClass 失败: %w", err)
	}
	// PV 数 → SC 名映射（PV 是 cluster-scoped，一次 List 即可）
	pvCount := map[string]int{}
	pvcCount := map[string]int{}
	if pvList, perr := cs.CoreV1().PersistentVolumes().List(ctx, metav1.ListOptions{}); perr == nil {
		for i := range pvList.Items {
			pv := &pvList.Items[i]
			if pv.Spec.StorageClassName != "" {
				pvCount[pv.Spec.StorageClassName]++
			}
		}
	}
	// PVC 数 → SC 名映射（PVC 全命名空间扫描）
	if pvcList, perr := cs.CoreV1().PersistentVolumeClaims(metav1.NamespaceAll).List(ctx, metav1.ListOptions{}); perr == nil {
		for i := range pvcList.Items {
			pvc := &pvcList.Items[i]
			if pvc.Spec.StorageClassName != nil {
				pvcCount[*pvc.Spec.StorageClassName]++
			}
		}
	}
	out := make([]model.StorageClass, 0, len(scList.Items))
	for i := range scList.Items {
		sc := &scList.Items[i]
		reclaim := "Delete"
		if sc.ReclaimPolicy != nil {
			reclaim = string(*sc.ReclaimPolicy)
		}
		bindMode := "Immediate"
		if sc.VolumeBindingMode != nil {
			bindMode = string(*sc.VolumeBindingMode)
		}
		// 「卷数」以 PV 关联为主（更贴近存储容量），PVC 仅作参考
		volumes := pvCount[sc.Name]
		if volumes == 0 {
			volumes = pvcCount[sc.Name]
		}
		out = append(out, model.StorageClass{
			Name:        sc.Name,
			Provisioner: sc.Provisioner,
			Reclaim:     reclaim,
			BindMode:    bindMode,
			IsDefault:   isDefaultStorageClass(scList.Items, sc.Name),
			Volumes:     volumes,
		})
	}
	sort.Slice(out, func(i, j int) bool {
		// 默认 SC 排前，否则按卷数降序
		if out[i].IsDefault != out[j].IsDefault {
			return out[i].IsDefault
		}
		return out[i].Volumes > out[j].Volumes
	})
	return out, nil
}

// isDefaultStorageClass K8s 通过 `storageclass.beta.kubernetes.io/is-default-class=true`
// 注解或 `storageclass.kubernetes.io/is-default-class=true`（v1.22+）标记默认 SC
func isDefaultStorageClass(items []storagev1.StorageClass, name string) bool {
	for i := range items {
		sc := &items[i]
		if sc.Name != name {
			continue
		}
		if v, ok := sc.Annotations["storageclass.kubernetes.io/is-default-class"]; ok && v == "true" {
			return true
		}
		if v, ok := sc.Annotations["storageclass.beta.kubernetes.io/is-default-class"]; ok && v == "true" {
			return true
		}
	}
	return false
}

// PVCs 列出集群所有命名空间的 PersistentVolumeClaim，把 K8s 资源对象映射为前端展示用 model.PVC。
// 容量：从 Spec.Resources.Requests.Storage 取；状态：Phase 转 ok/warn/err/idle；
// 已用：PVC 不像 PV 有 status.capacity 对比，常规 kubelet 不暴露 PVC 使用率（需 metrics-server
// + kubelet volume stats），这里给"—"占位。
func (m *Manager) PVCs(cid uint) ([]model.PVC, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	list, err := cs.CoreV1().PersistentVolumeClaims(metav1.NamespaceAll).List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("列 PVC 失败: %w", err)
	}
	out := make([]model.PVC, 0, len(list.Items))
	for i := range list.Items {
		pvc := &list.Items[i]
		capacity := "—"
		if q, ok := pvc.Spec.Resources.Requests[corev1.ResourceStorage]; ok {
			capacity = q.String()
		}
		scName := "—"
		if pvc.Spec.StorageClassName != nil {
			scName = *pvc.Spec.StorageClassName
		}
		access := pvcAccessModeString(pvc.Spec.AccessModes)
		out = append(out, model.PVC{
			Name:         pvc.Name,
			Namespace:    pvc.Namespace,
			Status:       pvcPhaseToTone(string(pvc.Status.Phase)),
			Capacity:     capacity,
			Used:         0,
			StorageClass: scName,
			Volume:       pvc.Spec.VolumeName, // 已绑定的 PV 名（未绑定为空）
			Access:       access,
			Age:          ageString(pvc.CreationTimestamp),
		})
	}
	// 排序：未绑定的 Pending 排前；其他按 namespace+name 稳定序
	sort.Slice(out, func(i, j int) bool {
		if out[i].Status != out[j].Status {
			return out[i].Status == "warn" // Pending/未就绪排前
		}
		if out[i].Namespace != out[j].Namespace {
			return out[i].Namespace < out[j].Namespace
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// pvcPhaseToTone K8s PVC.Phase → 前端徽章色调
//
//	Pending → warn（未绑定，等待 PV）
//	Bound   → ok
//	Lost    → err
//	其他    → idle
func pvcPhaseToTone(phase string) string {
	switch phase {
	case "Pending":
		return "warn"
	case "Bound":
		return "ok"
	case "Lost":
		return "err"
	default:
		return "idle"
	}
}

// pvcAccessModeString K8s PVC.Spec.AccessModes → 前端展示用的 RWO/RWX/ROX 字符串
func pvcAccessModeString(modes []corev1.PersistentVolumeAccessMode) string {
	if len(modes) == 0 {
		return "—"
	}
	parts := make([]string, 0, len(modes))
	for _, m := range modes {
		switch m {
		case corev1.ReadWriteOnce:
			parts = append(parts, "RWO")
		case corev1.ReadOnlyMany:
			parts = append(parts, "ROX")
		case corev1.ReadWriteMany:
			parts = append(parts, "RWX")
		default:
			parts = append(parts, string(m))
		}
	}
	return strings.Join(parts, ",")
}

// parseAccessModes 把前端 RWO/RWX/ROX（逗号分隔）字符串解析为 K8s AccessMode 列表。
// 空值默认 RWO（与 K8s 最常见诉求一致）。供 CreatePVC / CreatePV 复用。
func parseAccessModes(access string) []corev1.PersistentVolumeAccessMode {
	access = strings.TrimSpace(access)
	if access == "" {
		return []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce}
	}
	var modes []corev1.PersistentVolumeAccessMode
	for _, p := range strings.Split(access, ",") {
		switch strings.TrimSpace(p) {
		case "RWO":
			modes = append(modes, corev1.ReadWriteOnce)
		case "RWX":
			modes = append(modes, corev1.ReadWriteMany)
		case "ROX":
			modes = append(modes, corev1.ReadOnlyMany)
		}
	}
	if len(modes) == 0 {
		modes = []corev1.PersistentVolumeAccessMode{corev1.ReadWriteOnce}
	}
	return modes
}

// StorageSummary 集群级存储 KPI（用于存储页 KPI 卡）。
// 返回：sc 数 / pv 数 / pvc 数 / 已绑定 pvc 数 / 累计请求容量（GiB 单位）。
func (m *Manager) StorageSummary(cid uint) (*StorageSummaryInfo, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	out := &StorageSummaryInfo{}
	if scList, err := cs.StorageV1().StorageClasses().List(ctx, metav1.ListOptions{}); err == nil {
		out.StorageClassCount = len(scList.Items)
		for i := range scList.Items {
			if isDefaultStorageClass(scList.Items, scList.Items[i].Name) {
				out.DefaultStorageClass = scList.Items[i].Name
			}
		}
	}
	if pvList, err := cs.CoreV1().PersistentVolumes().List(ctx, metav1.ListOptions{}); err == nil {
		out.PVCount = len(pvList.Items)
		for i := range pvList.Items {
			if q, ok := pvList.Items[i].Spec.Capacity[corev1.ResourceStorage]; ok {
				out.TotalCapacityBytes += q.Value()
			}
		}
	}
	if pvcList, err := cs.CoreV1().PersistentVolumeClaims(metav1.NamespaceAll).List(ctx, metav1.ListOptions{}); err == nil {
		out.PVCCount = len(pvcList.Items)
		for i := range pvcList.Items {
			pvc := &pvcList.Items[i]
			if pvc.Status.Phase == corev1.ClaimBound {
				out.BoundCount++
			}
			if q, ok := pvc.Spec.Resources.Requests[corev1.ResourceStorage]; ok {
				out.RequestedBytes += q.Value()
			}
		}
	}
	if out.PVCCount > 0 {
		out.BindRate = int(float64(out.BoundCount) / float64(out.PVCCount) * 100)
	}
	return out, nil
}

// StorageSummaryInfo 存储卷 KPI 汇总（前端可选用）
type StorageSummaryInfo struct {
	StorageClassCount   int    `json:"storageClassCount"`
	PVCount             int    `json:"pvCount"`
	PVCCount            int    `json:"pvcCount"`
	BoundCount          int    `json:"boundCount"`
	BindRate            int    `json:"bindRate"` // 0-100
	TotalCapacityBytes  int64  `json:"totalCapacityBytes"`
	RequestedBytes      int64  `json:"requestedBytes"`
	DefaultStorageClass string `json:"defaultStorageClass"`
}

// ---------- 创建（真实集群写操作）----------

// CreateStorageClass 在集群创建一个 StorageClass（cluster-scoped，需要 admin 权限）。
// 入参的 VolumeBindingMode 字符串须为 K8s 接受的 "Immediate" 或 "WaitForFirstConsumer"；
// Provisioner 必须与集群中已安装的 CSI/内置驱动一致（如 kubernetes.io/aws-ebs / com.tencent.csi.cbs）。
func (m *Manager) CreateStorageClass(cid uint, in model.StorageClass) (*model.StorageClass, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	if in.Name == "" {
		return nil, fmt.Errorf("存储类名称不能为空")
	}
	if in.Provisioner == "" {
		return nil, fmt.Errorf("置备器不能为空")
	}
	reclaim := corev1.PersistentVolumeReclaimPolicy(in.Reclaim)
	if reclaim == "" {
		reclaim = corev1.PersistentVolumeReclaimDelete
	}
	bind := storagev1.VolumeBindingImmediate
	if in.BindMode == "WaitForFirstConsumer" {
		bind = storagev1.VolumeBindingWaitForFirstConsumer
	}
	sc := &storagev1.StorageClass{
		ObjectMeta: metav1.ObjectMeta{
			Name:        in.Name,
			Annotations: map[string]string{},
		},
		Provisioner:       in.Provisioner,
		ReclaimPolicy:     &reclaim,
		VolumeBindingMode: &bind,
	}
	// 若用户在弹窗勾选默认（model 没有该字段，约定：name 加 "default-" 前缀或 UI 标记）→ 略。
	// 这里尊重入参；调用方若有 isDefault 可通过 patch annotation 后续处理。
	out, err := cs.StorageV1().StorageClasses().Create(ctx, sc, metav1.CreateOptions{})
	if err != nil {
		return nil, fmt.Errorf("创建 StorageClass 失败: %w", err)
	}
	r := "Delete"
	if out.ReclaimPolicy != nil {
		r = string(*out.ReclaimPolicy)
	}
	bm := "Immediate"
	if out.VolumeBindingMode != nil {
		bm = string(*out.VolumeBindingMode)
	}
	return &model.StorageClass{
		Name:        out.Name,
		Provisioner: out.Provisioner,
		Reclaim:     r,
		BindMode:    bm,
		IsDefault:   isDefaultStorageClass([]storagev1.StorageClass{*out}, out.Name),
		Volumes:     0,
	}, nil
}

// CreatePVC 在集群的某 namespace 创建 PersistentVolumeClaim。
// 容量解析使用 resource.MustParse（容忍 "20Gi" / "1Ti" / "500Mi" 等常见写法）。
func (m *Manager) CreatePVC(cid uint, in model.PVC) (*model.PVC, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	if in.Name == "" {
		return nil, fmt.Errorf("PVC 名称不能为空")
	}
	if in.Namespace == "" {
		return nil, fmt.Errorf("命名空间不能为空")
	}
	if in.Capacity == "" {
		return nil, fmt.Errorf("容量不能为空")
	}
	capQty, err := resource.ParseQuantity(in.Capacity)
	if err != nil {
		return nil, fmt.Errorf("容量格式错误: %w", err)
	}
	modes := parseAccessModes(in.Access)
	scName := in.StorageClass
	pvc := &corev1.PersistentVolumeClaim{
		ObjectMeta: metav1.ObjectMeta{Name: in.Name, Namespace: in.Namespace},
		Spec: corev1.PersistentVolumeClaimSpec{
			AccessModes: modes,
			Resources: corev1.VolumeResourceRequirements{
				Requests: corev1.ResourceList{corev1.ResourceStorage: capQty},
			},
		},
	}
	if scName != "" && scName != "—" {
		pvc.Spec.StorageClassName = &scName
	}
	out, err := cs.CoreV1().PersistentVolumeClaims(in.Namespace).Create(ctx, pvc, metav1.CreateOptions{})
	if err != nil {
		return nil, fmt.Errorf("创建 PVC 失败: %w", err)
	}
	return &model.PVC{
		Name:         out.Name,
		Namespace:    out.Namespace,
		Status:       pvcPhaseToTone(string(out.Status.Phase)),
		Capacity:     in.Capacity,
		Used:         0,
		StorageClass: scName,
		Volume:       out.Spec.VolumeName,
		Access:       pvcAccessModeString(out.Spec.AccessModes),
		Age:          ageString(out.CreationTimestamp),
	}, nil
}

// ---------- PV（PersistentVolume）列表 / 创建 ----------

// pvToModel 把 K8s PersistentVolume 映射为前端只读 model（PVs 列表与 CreatePV 复用）。
func pvToModel(pv *corev1.PersistentVolume) *model.PersistentVolume {
	cap := "—"
	if q, ok := pv.Spec.Capacity[corev1.ResourceStorage]; ok {
		cap = q.String()
	}
	claim := "—"
	if pv.Spec.ClaimRef != nil && pv.Spec.ClaimRef.Namespace != "" {
		claim = pv.Spec.ClaimRef.Namespace + "/" + pv.Spec.ClaimRef.Name
	}
	reclaim := "Delete"
	if pv.Spec.PersistentVolumeReclaimPolicy != "" {
		reclaim = string(pv.Spec.PersistentVolumeReclaimPolicy)
	}
	return &model.PersistentVolume{
		Name:          pv.Name,
		Capacity:      cap,
		StorageClass:  pv.Spec.StorageClassName,
		AccessModes:   pvcAccessModeString(pv.Spec.AccessModes),
		Status:        pvPhaseToTone(string(pv.Status.Phase)),
		Phase:         string(pv.Status.Phase),
		Claim:         claim,
		ReclaimPolicy: reclaim,
		Source:        pvSourceString(pv),
		Age:           ageString(pv.CreationTimestamp),
		Labels:        pv.Labels,
		Annotations:   pv.Annotations,
	}
}

// CreatePV 在集群创建一个 PersistentVolume（cluster-scoped，需要 admin 权限）。
// 来源支持 hostPath / nfs / local / csi；local 可填 nodeName 写入 nodeAffinity 以便调度。
// 返回创建后的 PV 映射（含 K8s 分配的 Phase 等）。错误透传。
func (m *Manager) CreatePV(cid uint, in model.PersistentVolumeInput) (*model.PersistentVolume, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	if in.Name == "" {
		return nil, fmt.Errorf("PV 名称不能为空")
	}
	if in.Capacity == "" {
		return nil, fmt.Errorf("容量不能为空")
	}
	capQty, err := resource.ParseQuantity(in.Capacity)
	if err != nil {
		return nil, fmt.Errorf("容量格式错误: %w", err)
	}
	reclaim := corev1.PersistentVolumeReclaimPolicy(in.ReclaimPolicy)
	if reclaim == "" {
		reclaim = corev1.PersistentVolumeReclaimDelete
	}
	pv := &corev1.PersistentVolume{
		ObjectMeta: metav1.ObjectMeta{
			Name:        in.Name,
			Labels:      in.Labels,
			Annotations: in.Annotations,
		},
		Spec: corev1.PersistentVolumeSpec{
			Capacity:                      corev1.ResourceList{corev1.ResourceStorage: capQty},
			AccessModes:                   parseAccessModes(in.AccessModes),
			PersistentVolumeReclaimPolicy: reclaim,
			StorageClassName:              in.StorageClass,
		},
	}
	switch in.SourceType {
	case "hostPath":
		if in.SourceHostPath == "" {
			return nil, fmt.Errorf("HostPath 路径不能为空")
		}
		pv.Spec.HostPath = &corev1.HostPathVolumeSource{Path: in.SourceHostPath}
	case "nfs":
		if in.SourceNFSServer == "" || in.SourceNFSPath == "" {
			return nil, fmt.Errorf("NFS 的 server 与 path 均不能为空")
		}
		pv.Spec.NFS = &corev1.NFSVolumeSource{Server: in.SourceNFSServer, Path: in.SourceNFSPath}
	case "local":
		if in.SourceLocalPath == "" {
			return nil, fmt.Errorf("Local 路径不能为空")
		}
		pv.Spec.Local = &corev1.LocalVolumeSource{Path: in.SourceLocalPath}
		// Local PV 必须带 nodeAffinity 才能被调度器识别落到哪个节点；
		// 用户填了 nodeName 就写入 required node selector（kubernetes.io/hostname）。
		if in.SourceLocalNode != "" {
			pv.Spec.NodeAffinity = &corev1.VolumeNodeAffinity{
				Required: &corev1.NodeSelector{
					NodeSelectorTerms: []corev1.NodeSelectorTerm{
						{
							MatchExpressions: []corev1.NodeSelectorRequirement{
								{
									Key:      "kubernetes.io/hostname",
									Operator: corev1.NodeSelectorOpIn,
									Values:   []string{in.SourceLocalNode},
								},
							},
						},
					},
				},
			}
		}
	case "csi":
		if in.SourceCSIDriver == "" || in.SourceCSIVolumeHandle == "" {
			return nil, fmt.Errorf("CSI 的 driver 与 volumeHandle 均不能为空")
		}
		pv.Spec.CSI = &corev1.CSIPersistentVolumeSource{
			Driver:       in.SourceCSIDriver,
			VolumeHandle: in.SourceCSIVolumeHandle,
			FSType:       in.SourceCSIFSType,
		}
	default:
		return nil, fmt.Errorf("不支持的来源类型 %q（支持 hostPath/nfs/local/csi）", in.SourceType)
	}
	out, err := cs.CoreV1().PersistentVolumes().Create(ctx, pv, metav1.CreateOptions{})
	if err != nil {
		return nil, fmt.Errorf("创建 PV 失败: %w", err)
	}
	return pvToModel(out), nil
}

// PVs 列出集群所有 PersistentVolume（cluster-scoped）。
// Phase 映射：Available/Bound→ok；Released→warn；Failed→err；其他→idle。
// Source 来自 K8s Spec 子类型（HostPath/NFS/CSI/AWS EBS 等），序列化为字符串便于前端展示。
func (m *Manager) PVs(cid uint) ([]model.PersistentVolume, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	list, err := cs.CoreV1().PersistentVolumes().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("列 PV 失败: %w", err)
	}
	out := make([]model.PersistentVolume, 0, len(list.Items))
	for i := range list.Items {
		out = append(out, *pvToModel(&list.Items[i]))
	}
	sort.Slice(out, func(i, j int) bool {
		if (out[i].Status == "ok") != (out[j].Status == "ok") {
			return out[i].Status == "ok"
		}
		return out[i].Name < out[j].Name
	})
	return out, nil
}

// pvPhaseToTone K8s PV.Phase → 前端徽章色调
func pvPhaseToTone(phase string) string {
	switch phase {
	case "Available", "Bound":
		return "ok"
	case "Released":
		return "warn"
	case "Failed":
		return "err"
	default:
		return "idle"
	}
}

// pvSourceString 把 PV.Spec 各 Source 子类型序列化为可读字符串
func pvSourceString(pv *corev1.PersistentVolume) string {
	spec := pv.Spec
	switch {
	case spec.HostPath != nil:
		return "HostPath:" + spec.HostPath.Path
	case spec.NFS != nil:
		return fmt.Sprintf("NFS:%s:%s", spec.NFS.Server, spec.NFS.Path)
	case spec.AWSElasticBlockStore != nil:
		return "AWS EBS:" + spec.AWSElasticBlockStore.VolumeID
	case spec.GCEPersistentDisk != nil:
		return "GCE PD:" + spec.GCEPersistentDisk.PDName
	case spec.CSI != nil:
		return "CSI:" + spec.CSI.Driver
	case spec.Local != nil:
		return "Local:" + spec.Local.Path
	case spec.ISCSI != nil:
		return "iSCSI:" + spec.ISCSI.IQN
	case spec.RBD != nil:
		if len(spec.RBD.CephMonitors) > 0 {
			return "RBD:" + spec.RBD.CephMonitors[0]
		}
		return "RBD"
	default:
		return "—"
	}
}

// ---------- 详情查询（带完整 K8s 对象元信息 + YAML）----------

type StorageClassDetail struct {
	StorageClass model.StorageClass `json:"storageClass"`
	Parameters   map[string]string  `json:"parameters"`
	Labels       map[string]string  `json:"labels"`
	Annotations  map[string]string  `json:"annotations"`
	YAML         string             `json:"yaml"`
}

func (m *Manager) StorageClassDetail(cid uint, name string) (*StorageClassDetail, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	scObj, err := cs.StorageV1().StorageClasses().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if apierr.IsNotFound(err) {
			return nil, fmt.Errorf("StorageClass %q 不存在", name)
		}
		return nil, fmt.Errorf("查询 StorageClass 失败: %w", err)
	}
	list, err := cs.StorageV1().StorageClasses().List(ctx, metav1.ListOptions{})
	if err != nil {
		return nil, fmt.Errorf("列 SC（用于 isDefault）失败: %w", err)
	}
	pvCount := map[string]int{}
	if pvList, perr := cs.CoreV1().PersistentVolumes().List(ctx, metav1.ListOptions{}); perr == nil {
		for i := range pvList.Items {
			if pvList.Items[i].Spec.StorageClassName == name {
				pvCount[name]++
			}
		}
	}
	reclaim := "Delete"
	if scObj.ReclaimPolicy != nil {
		reclaim = string(*scObj.ReclaimPolicy)
	}
	bind := "Immediate"
	if scObj.VolumeBindingMode != nil {
		bind = string(*scObj.VolumeBindingMode)
	}
	return &StorageClassDetail{
		StorageClass: model.StorageClass{
			Name: scObj.Name, Provisioner: scObj.Provisioner, Reclaim: reclaim, BindMode: bind,
			IsDefault: isDefaultStorageClass(list.Items, scObj.Name), Volumes: pvCount[name],
		},
		Parameters:  scObj.Parameters,
		Labels:      scObj.Labels,
		Annotations: scObj.Annotations,
		YAML:        scToYAML(scObj),
	}, nil
}

// sortedKeys 返回 map key 的字典序切片（YAML 输出稳定排序）
func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

// scToYAML 把 StorageClass 序列化为简易 YAML
func scToYAML(sc *storagev1.StorageClass) string {
	if sc == nil {
		return ""
	}
	b := strings.Builder{}
	b.WriteString("apiVersion: storage.k8s.io/v1\n")
	b.WriteString("kind: StorageClass\n")
	b.WriteString("metadata:\n")
	b.WriteString("  name: " + sc.Name + "\n")
	if len(sc.Annotations) > 0 {
		b.WriteString("  annotations:\n")
		for _, k := range sortedKeys(sc.Annotations) {
			b.WriteString(fmt.Sprintf("    %s: %q\n", k, sc.Annotations[k]))
		}
	}
	b.WriteString("provisioner: " + sc.Provisioner + "\n")
	if sc.ReclaimPolicy != nil {
		b.WriteString("reclaimPolicy: " + string(*sc.ReclaimPolicy) + "\n")
	}
	if sc.VolumeBindingMode != nil {
		b.WriteString("volumeBindingMode: " + string(*sc.VolumeBindingMode) + "\n")
	}
	if len(sc.Parameters) > 0 {
		b.WriteString("parameters:\n")
		for _, k := range sortedKeys(sc.Parameters) {
			b.WriteString(fmt.Sprintf("  %s: %q\n", k, sc.Parameters[k]))
		}
	}
	return b.String()
}

type PVDetail struct {
	PersistentVolume model.PersistentVolume `json:"persistentVolume"`
	SourceRaw        map[string]interface{} `json:"sourceRaw"`
	YAML             string                 `json:"yaml"`
}

func (m *Manager) PVDetail(cid uint, name string) (*PVDetail, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	pv, err := cs.CoreV1().PersistentVolumes().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if apierr.IsNotFound(err) {
			return nil, fmt.Errorf("PV %q 不存在", name)
		}
		return nil, fmt.Errorf("查询 PV 失败: %w", err)
	}
	cap := "—"
	if q, ok := pv.Spec.Capacity[corev1.ResourceStorage]; ok {
		cap = q.String()
	}
	claim := "—"
	if pv.Spec.ClaimRef != nil && pv.Spec.ClaimRef.Namespace != "" {
		claim = pv.Spec.ClaimRef.Namespace + "/" + pv.Spec.ClaimRef.Name
	}
	reclaim := "Delete"
	if pv.Spec.PersistentVolumeReclaimPolicy != "" {
		reclaim = string(pv.Spec.PersistentVolumeReclaimPolicy)
	}
	out := &PVDetail{
		PersistentVolume: model.PersistentVolume{
			Name: pv.Name, Capacity: cap, StorageClass: pv.Spec.StorageClassName,
			AccessModes: pvcAccessModeString(pv.Spec.AccessModes),
			Status:      pvPhaseToTone(string(pv.Status.Phase)),
			Phase:       string(pv.Status.Phase),
			Claim:       claim, ReclaimPolicy: reclaim, Source: pvSourceString(pv),
			Age: ageString(pv.CreationTimestamp), Labels: pv.Labels, Annotations: pv.Annotations,
		},
		YAML: pvToYAML(pv),
	}
	if pv.Spec.HostPath != nil {
		out.SourceRaw = map[string]interface{}{"type": "HostPath", "path": pv.Spec.HostPath.Path}
	} else if pv.Spec.NFS != nil {
		out.SourceRaw = map[string]interface{}{"type": "NFS", "server": pv.Spec.NFS.Server, "path": pv.Spec.NFS.Path, "readOnly": pv.Spec.NFS.ReadOnly}
	} else if pv.Spec.CSI != nil {
		out.SourceRaw = map[string]interface{}{"type": "CSI", "driver": pv.Spec.CSI.Driver, "volumeHandle": pv.Spec.CSI.VolumeHandle, "fsType": pv.Spec.CSI.FSType}
	} else if pv.Spec.Local != nil {
		out.SourceRaw = map[string]interface{}{"type": "Local", "path": pv.Spec.Local.Path, "fsType": pv.Spec.Local.FSType}
	} else if pv.Spec.AWSElasticBlockStore != nil {
		out.SourceRaw = map[string]interface{}{"type": "AWS EBS", "volumeID": pv.Spec.AWSElasticBlockStore.VolumeID}
	}
	return out, nil
}

// pvToYAML 把 PV 序列化为简易 YAML
func pvToYAML(pv *corev1.PersistentVolume) string {
	if pv == nil {
		return ""
	}
	b := strings.Builder{}
	b.WriteString("apiVersion: v1\n")
	b.WriteString("kind: PersistentVolume\n")
	b.WriteString("metadata:\n")
	b.WriteString("  name: " + pv.Name + "\n")
	if len(pv.Annotations) > 0 {
		b.WriteString("  annotations:\n")
		for _, k := range sortedKeys(pv.Annotations) {
			b.WriteString(fmt.Sprintf("    %s: %q\n", k, pv.Annotations[k]))
		}
	}
	b.WriteString("spec:\n")
	if pv.Spec.StorageClassName != "" {
		b.WriteString("  storageClassName: " + pv.Spec.StorageClassName + "\n")
	}
	if pv.Spec.PersistentVolumeReclaimPolicy != "" {
		b.WriteString("  persistentVolumeReclaimPolicy: " + string(pv.Spec.PersistentVolumeReclaimPolicy) + "\n")
	}
	if len(pv.Spec.AccessModes) > 0 {
		parts := make([]string, 0, len(pv.Spec.AccessModes))
		for _, m := range pv.Spec.AccessModes {
			parts = append(parts, string(m))
		}
		b.WriteString("  accessModes:\n")
		for _, m := range parts {
			b.WriteString("    - " + m + "\n")
		}
	}
	if q, ok := pv.Spec.Capacity[corev1.ResourceStorage]; ok {
		b.WriteString("  capacity:\n    storage: " + q.String() + "\n")
	}
	switch {
	case pv.Spec.HostPath != nil:
		b.WriteString("  hostPath:\n    path: " + pv.Spec.HostPath.Path + "\n")
	case pv.Spec.NFS != nil:
		b.WriteString("  nfs:\n    server: " + pv.Spec.NFS.Server + "\n    path: " + pv.Spec.NFS.Path + "\n")
	case pv.Spec.CSI != nil:
		b.WriteString("  csi:\n    driver: " + pv.Spec.CSI.Driver + "\n    volumeHandle: " + pv.Spec.CSI.VolumeHandle + "\n")
	}
	if pv.Spec.ClaimRef != nil && pv.Spec.ClaimRef.Namespace != "" {
		b.WriteString(fmt.Sprintf("  claimRef:\n    namespace: %s\n    name: %s\n", pv.Spec.ClaimRef.Namespace, pv.Spec.ClaimRef.Name))
	}
	return b.String()
}

type PVCDetail struct {
	PVC  model.PVC `json:"pvc"`
	YAML string    `json:"yaml"`
}

func (m *Manager) PVCDetail(cid uint, ns, name string) (*PVCDetail, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	pvc, err := cs.CoreV1().PersistentVolumeClaims(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if apierr.IsNotFound(err) {
			return nil, fmt.Errorf("PVC %s/%s 不存在", ns, name)
		}
		return nil, fmt.Errorf("查询 PVC 失败: %w", err)
	}
	cap := "—"
	if q, ok := pvc.Spec.Resources.Requests[corev1.ResourceStorage]; ok {
		cap = q.String()
	}
	scName := "—"
	if pvc.Spec.StorageClassName != nil {
		scName = *pvc.Spec.StorageClassName
	}
	return &PVCDetail{
		PVC: model.PVC{
			Name: pvc.Name, Namespace: pvc.Namespace, Status: pvcPhaseToTone(string(pvc.Status.Phase)),
			Capacity: cap, Used: 0, StorageClass: scName, Volume: pvc.Spec.VolumeName,
			Access: pvcAccessModeString(pvc.Spec.AccessModes), Age: ageString(pvc.CreationTimestamp),
		},
		YAML: pvcToYAML(pvc),
	}, nil
}

// pvcToYAML 把 PVC 序列化为简易 YAML
func pvcToYAML(pvc *corev1.PersistentVolumeClaim) string {
	if pvc == nil {
		return ""
	}
	b := strings.Builder{}
	b.WriteString("apiVersion: v1\n")
	b.WriteString("kind: PersistentVolumeClaim\n")
	b.WriteString("metadata:\n")
	b.WriteString("  name: " + pvc.Name + "\n")
	b.WriteString("  namespace: " + pvc.Namespace + "\n")
	b.WriteString("status:\n")
	b.WriteString("  phase: " + string(pvc.Status.Phase) + "\n")
	b.WriteString("spec:\n")
	b.WriteString("  accessModes:\n")
	for _, m := range pvc.Spec.AccessModes {
		b.WriteString("    - " + string(m) + "\n")
	}
	if pvc.Spec.StorageClassName != nil {
		b.WriteString("  storageClassName: " + *pvc.Spec.StorageClassName + "\n")
	}
	if len(pvc.Spec.Resources.Requests) > 0 {
		b.WriteString("  resources:\n    requests:\n")
		for rk, q := range pvc.Spec.Resources.Requests {
			b.WriteString(fmt.Sprintf("      %s: %s\n", rk, q.String()))
		}
	}
	if pvc.Spec.VolumeName != "" {
		b.WriteString("  volumeName: " + pvc.Spec.VolumeName + "\n")
	}
	return b.String()
}

// ---------- 修改（真实集群写操作）----------

// SCUpdate K8s 中 provisioner/reclaimPolicy/volumeBindingMode 不可改，仅 parameters/annotations 可改。
// Parameters/Annotations 都是**合并更新**（key 在传入 map 中则替换，未传则保留原值），
// 这样前端"修改"按钮只回传用户编辑过的字段，不会把整个 map 重置成空，避免误覆盖 SC 关键配置（如 openebs cas.config）。
type SCUpdate struct {
	Parameters  map[string]string `json:"parameters"`
	Annotations map[string]string `json:"annotations"`
}

func (m *Manager) UpdateStorageClass(cid uint, name string, in SCUpdate) (*StorageClassDetail, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	sc, err := cs.StorageV1().StorageClasses().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if apierr.IsNotFound(err) {
			return nil, fmt.Errorf("StorageClass %q 不存在", name)
		}
		return nil, err
	}
	if in.Parameters != nil {
		if sc.Parameters == nil {
			sc.Parameters = map[string]string{}
		}
		for k, v := range in.Parameters {
			sc.Parameters[k] = v
		}
	}
	if in.Annotations != nil {
		if sc.Annotations == nil {
			sc.Annotations = map[string]string{}
		}
		for k, v := range in.Annotations {
			sc.Annotations[k] = v
		}
	}
	if _, err := cs.StorageV1().StorageClasses().Update(ctx, sc, metav1.UpdateOptions{}); err != nil {
		return nil, fmt.Errorf("更新 StorageClass 失败: %w", err)
	}
	return m.StorageClassDetail(cid, name)
}

// PVUpdate K8s 中 spec.capacity/accessModes/storageClassName 不可改；可改 reclaimPolicy/annotations。
type PVUpdate struct {
	ReclaimPolicy string            `json:"reclaimPolicy"`
	Annotations   map[string]string `json:"annotations"`
}

func (m *Manager) UpdatePV(cid uint, name string, in PVUpdate) (*PVDetail, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	pv, err := cs.CoreV1().PersistentVolumes().Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if apierr.IsNotFound(err) {
			return nil, fmt.Errorf("PV %q 不存在", name)
		}
		return nil, err
	}
	if in.ReclaimPolicy != "" {
		pv.Spec.PersistentVolumeReclaimPolicy = corev1.PersistentVolumeReclaimPolicy(in.ReclaimPolicy)
	}
	if in.Annotations != nil {
		if pv.Annotations == nil {
			pv.Annotations = map[string]string{}
		}
		for k, v := range in.Annotations {
			pv.Annotations[k] = v
		}
	}
	if _, err := cs.CoreV1().PersistentVolumes().Update(ctx, pv, metav1.UpdateOptions{}); err != nil {
		return nil, fmt.Errorf("更新 PV 失败: %w", err)
	}
	return m.PVDetail(cid, name)
}

// PVCUpdate K8s PVC 仅允许扩缩容 resources.requests.storage（不能缩）。
type PVCUpdate struct {
	Capacity string `json:"capacity"`
}

func (m *Manager) UpdatePVC(cid uint, ns, name string, in PVCUpdate) (*PVCDetail, error) {
	cs, err := m.Clientset(cid)
	if err != nil {
		return nil, err
	}
	ctx := context.TODO()
	pvc, err := cs.CoreV1().PersistentVolumeClaims(ns).Get(ctx, name, metav1.GetOptions{})
	if err != nil {
		if apierr.IsNotFound(err) {
			return nil, fmt.Errorf("PVC %s/%s 不存在", ns, name)
		}
		return nil, err
	}
	if in.Capacity == "" {
		return nil, fmt.Errorf("PVC 容量不能为空")
	}
	curQty, curOk := pvc.Spec.Resources.Requests[corev1.ResourceStorage]
	newQty, err := resource.ParseQuantity(in.Capacity)
	if err != nil {
		return nil, fmt.Errorf("容量格式错误: %w", err)
	}
	if !curOk {
		return nil, fmt.Errorf("当前 PVC 未设置 Resources.Storage，无法对比")
	}
	if newQty.Cmp(curQty) < 0 {
		return nil, fmt.Errorf("PVC 仅允许扩缩容向更大的容量（当前 %s → 请求 %s）", curQty.String(), newQty.String())
	}
	pvc.Spec.Resources.Requests[corev1.ResourceStorage] = newQty
	if _, err := cs.CoreV1().PersistentVolumeClaims(ns).Update(ctx, pvc, metav1.UpdateOptions{}); err != nil {
		return nil, fmt.Errorf("更新 PVC 失败: %w", err)
	}
	return m.PVCDetail(cid, ns, name)
}

// DeletePVC 删除 PVC（仅真实集群；前端测试清理用）。
// K8s 默认 propagationPolicy=Orphan（不删 PV）；这里采用 Background 让 PV 按 ReclaimPolicy 回收。
func (m *Manager) DeletePVC(cid uint, ns, name string) error {
	cs, err := m.Clientset(cid)
	if err != nil {
		return err
	}
	ctx := context.TODO()
	propagation := metav1.DeletePropagationBackground
	if err := cs.CoreV1().PersistentVolumeClaims(ns).Delete(ctx, name, metav1.DeleteOptions{PropagationPolicy: &propagation}); err != nil {
		if apierr.IsNotFound(err) {
			return nil // 幂等：已删就当成功
		}
		return fmt.Errorf("删除 PVC 失败: %w", err)
	}
	return nil
}

// DeletePV 删除 PV（仅真实集群；cluster-scoped）。NotFound 视为幂等成功。
func (m *Manager) DeletePV(cid uint, name string) error {
	cs, err := m.Clientset(cid)
	if err != nil {
		return err
	}
	ctx := context.TODO()
	if err := cs.CoreV1().PersistentVolumes().Delete(ctx, name, metav1.DeleteOptions{}); err != nil {
		if apierr.IsNotFound(err) {
			return nil
		}
		return fmt.Errorf("删除 PV 失败: %w", err)
	}
	return nil
}

// DeleteStorageClass 删除 StorageClass（仅真实集群；cluster-scoped）。NotFound 视为幂等成功。
func (m *Manager) DeleteStorageClass(cid uint, name string) error {
	cs, err := m.Clientset(cid)
	if err != nil {
		return err
	}
	ctx := context.TODO()
	if err := cs.StorageV1().StorageClasses().Delete(ctx, name, metav1.DeleteOptions{}); err != nil {
		if apierr.IsNotFound(err) {
			return nil
		}
		return fmt.Errorf("删除 StorageClass 失败: %w", err)
	}
	return nil
}