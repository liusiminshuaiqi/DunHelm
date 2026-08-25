package seed

import (
	"log"

	"kubehelm/server/internal/crypto"
	"kubehelm/server/internal/model"

	"gorm.io/gorm"
)

func sp(s string) *string { return &s }
func ip(i int) *int       { return &i }

// 内置用户的统一初始密码（首次 seed 与旧库补齐共用），引用 model 包常量保持一致。
const defaultUserPassword = model.DefaultUserPassword

// Run 首次启动时把原型 mock 数据写入数据库；若已存在则跳过
func Run(db *gorm.DB) {
	var cnt int64
	db.Model(&model.Cluster{}).Count(&cnt)
	if cnt > 0 {
		return
	}

	db.Create(&model.Cluster{
		Name: "prod-cluster-01", Version: "v1.29.4", Provider: "Tencent TKE", Region: "ap-guangzhou",
		Nodes: 18, Pods: 642, CpuUsed: 312, CpuTotal: 576, MemUsed: 1184, MemTotal: 2304,
	})

	db.Create([]model.Namespace{
		{Name: "kube-system", Cpu: 78, Mem: 64, Pods: 92},
		{Name: "ns-payment", Cpu: 56, Mem: 71, Pods: 148},
		{Name: "ns-order", Cpu: 43, Mem: 52, Pods: 121},
		{Name: "ns-gateway", Cpu: 88, Mem: 60, Pods: 36},
		{Name: "ns-ai-train", Cpu: 34, Mem: 79, Pods: 64},
		{Name: "ns-monitor", Cpu: 41, Mem: 47, Pods: 58},
	})

	db.Create([]model.Event{
		{Time: "16:42", Type: "ok", Reason: "Pulled", Obj: "payment-api-7d9f", Msg: "Successfully pulled image registry.local/payment:1.8.2"},
		{Time: "16:39", Type: "warn", Reason: "OOMKilled", Obj: "train-worker-3", Msg: "Container exceeded memory limit 4Gi, restarted"},
		{Time: "16:31", Type: "info", Reason: "Scaling", Obj: "gateway-hpa", Msg: "Scaled up from 4 to 6 replicas (CPU 88%)"},
		{Time: "16:28", Type: "err", Reason: "BackOff", Obj: "order-svc-5c2", Msg: "ImagePullBackOff: manifest unknown for order:latest"},
		{Time: "16:20", Type: "ok", Reason: "Created", Obj: "monitor-grafana", Msg: "Started container grafana"},
		{Time: "16:11", Type: "info", Reason: "Sync", Obj: "coredns", Msg: "ConfigMap reloaded, 6 upstreams"},
		{Time: "16:02", Type: "ok", Reason: "Ready", Obj: "node-gz-06", Msg: "Node cordon lifted, scheduling enabled"},
	})

	db.Create([]model.Node{
		{Name: "node-gz-01", Role: "control-plane", Status: "ok", Cpu: 38, Mem: 55, Disk: 41, Pods: 41, PodTotal: 110, Version: "v1.29.4", IP: "10.0.12.11", OS: "Ubuntu 22.04", Kubelet: "v1.29.4", Age: "188d"},
		{Name: "node-gz-02", Role: "control-plane", Status: "ok", Cpu: 42, Mem: 60, Disk: 38, Pods: 38, PodTotal: 110, Version: "v1.29.4", IP: "10.0.12.12", OS: "Ubuntu 22.04", Kubelet: "v1.29.4", Age: "188d"},
		{Name: "node-gz-03", Role: "worker", Status: "ok", Cpu: 67, Mem: 73, Disk: 62, Pods: 52, PodTotal: 110, Version: "v1.29.4", IP: "10.0.13.21", OS: "Ubuntu 22.04", Kubelet: "v1.29.4", Age: "176d"},
		{Name: "node-gz-04", Role: "worker", Status: "warn", Cpu: 91, Mem: 84, Disk: 88, Pods: 61, PodTotal: 110, Version: "v1.29.4", IP: "10.0.13.22", OS: "Ubuntu 22.04", Kubelet: "v1.29.4", Age: "176d"},
		{Name: "node-gz-05", Role: "worker", Status: "ok", Cpu: 58, Mem: 49, Disk: 51, Pods: 44, PodTotal: 110, Version: "v1.29.4", IP: "10.0.13.23", OS: "Ubuntu 22.04", Kubelet: "v1.29.4", Age: "120d"},
		{Name: "node-gz-06", Role: "worker", Status: "updating", Cpu: 12, Mem: 22, Disk: 18, Pods: 9, PodTotal: 110, Version: "v1.29.4", IP: "10.0.13.24", OS: "Ubuntu 22.04", Kubelet: "v1.29.4", Age: "3d"},
	})

	db.Create([]model.Workload{
		{Name: "payment-api", Namespace: "ns-payment", Kind: "deployment", Status: "ok", Desired: 6, Ready: 6, Image: "registry.local/payment:1.8.2", Cpu: 320, Restarts: 0, Age: "42d", Pods: model.StringSlice{"ok", "ok", "ok", "ok", "ok", "ok"}},
		{Name: "order-svc", Namespace: "ns-order", Kind: "deployment", Status: "updating", Desired: 5, Ready: 4, Image: "registry.local/order:2.3.0", Cpu: 410, Restarts: 1, Age: "12d", Pods: model.StringSlice{"ok", "ok", "ok", "ok", "updating"}},
		{Name: "gateway-envoy", Namespace: "ns-gateway", Kind: "daemonset", Status: "ok", Desired: 6, Ready: 6, Image: "registry.local/envoy:1.29", Cpu: 180, Restarts: 0, Age: "88d", Pods: model.StringSlice{"ok", "ok", "ok", "ok", "ok", "ok"}},
		{Name: "ai-train-operator", Namespace: "ns-ai-train", Kind: "statefulset", Status: "err", Desired: 3, Ready: 1, Image: "registry.local/ai-operator:0.9.1", Cpu: 920, Restarts: 7, Age: "3d", Pods: model.StringSlice{"err", "err", "ok"}},
		{Name: "user-svc", Namespace: "ns-payment", Kind: "deployment", Status: "ok", Desired: 4, Ready: 4, Image: "registry.local/user:4.1.0", Cpu: 210, Restarts: 0, Age: "21d", Pods: model.StringSlice{"ok", "ok", "ok", "ok"}},
		{Name: "notify-worker", Namespace: "ns-order", Kind: "deployment", Status: "pending", Desired: 2, Ready: 0, Image: "registry.local/notify:1.2.0", Cpu: 0, Restarts: 0, Age: "5m", Pods: model.StringSlice{"pending", "pending"}},
		{Name: "grafana", Namespace: "ns-monitor", Kind: "statefulset", Status: "ok", Desired: 1, Ready: 1, Image: "registry.local/grafana:11.0", Cpu: 95, Restarts: 0, Age: "120d", Pods: model.StringSlice{"ok"}},
		{Name: "elasticsearch", Namespace: "ns-monitor", Kind: "statefulset", Status: "ok", Desired: 3, Ready: 3, Image: "registry.local/es:8.13", Cpu: 640, Restarts: 2, Age: "120d", Pods: model.StringSlice{"ok", "ok", "ok"}},
	})

	// 构建阶段（seed 用合成日志，与 CI 引擎风格一致）
	mkStages := func(specs ...[2]string) model.BuildStageSlice {
		ss := make(model.BuildStageSlice, 0, len(specs))
		for _, sp := range specs {
			status := sp[1]
			log := "[" + sp[0] + "] 开始执行 …\n[" + sp[0] + "] 完成 ✓\n"
			if status == "err" {
				log = "[" + sp[0] + "] 开始执行 …\n[" + sp[0] + "] 失败: exit code 1\n"
			}
			ss = append(ss, model.BuildStage{Name: sp[0], Status: status, Log: log, StartedAt: "16:00:00", FinishedAt: "16:00:03"})
		}
		return ss
	}

	db.Create([]model.Pipeline{
		{Name: "payment-api-ci", Repo: "plat/payment-api", Branch: "main", LastStatus: "ok", Duration: "4m12s", Trigger: "push", LastRun: "16:38",
			IsTemplate: true,
			Stages: model.StageSlice{{Name: "Clone"}, {Name: "Build"}, {Name: "Test"}, {Name: "Image"}, {Name: "Deploy"}},
			Spark:  model.IntSlice{62, 70, 58, 74, 80, 66, 88, 76, 90, 84}},
		{Name: "order-svc-cd", Repo: "plat/order-svc", Branch: "release/2.3", LastStatus: "ok", Duration: "2m48s", Trigger: "merge", LastRun: "16:40",
			IsTemplate: true,
			Stages: model.StageSlice{{Name: "Clone"}, {Name: "Build"}, {Name: "Test"}, {Name: "Image"}, {Name: "Deploy"}},
			Spark:  model.IntSlice{40, 52, 48, 60, 55, 70, 64, 78, 72, 81}},
		{Name: "gateway-envoy-ci", Repo: "infra/envoy", Branch: "main", LastStatus: "ok", Duration: "6m03s", Trigger: "schedule", LastRun: "15:55",
			IsTemplate: true,
			Stages: model.StageSlice{{Name: "Clone"}, {Name: "Build"}, {Name: "Test"}, {Name: "Image"}, {Name: "Deploy"}},
			Spark:  model.IntSlice{30, 35, 42, 38, 50, 47, 55, 60, 58, 64}},
		{Name: "ai-operator-build", Repo: "ml/ai-operator", Branch: "dev", LastStatus: "err", Duration: "1m20s", Trigger: "push", LastRun: "16:18",
			IsTemplate: true,
			Stages: model.StageSlice{{Name: "Clone"}, {Name: "Build"}, {Name: "Test"}, {Name: "Image"}, {Name: "Deploy"}},
			Spark:  model.IntSlice{20, 28, 24, 30, 26, 18, 22, 15, 12, 10}},
		{Name: "user-svc-ci", Repo: "plat/user-svc", Branch: "main", LastStatus: "ok", Duration: "3m31s", Trigger: "push", LastRun: "16:02",
			IsTemplate: true,
			Stages: model.StageSlice{{Name: "Clone"}, {Name: "Build"}, {Name: "Test"}, {Name: "Image"}, {Name: "Deploy"}},
			Spark:  model.IntSlice{50, 58, 54, 62, 68, 60, 72, 70, 78, 82}},
		{Name: "notify-worker-ci", Repo: "plat/notify-worker", Branch: "main", LastStatus: "ok", Duration: "2m11s", Trigger: "push", LastRun: "15:12",
			Stages: model.StageSlice{{Name: "Clone"}, {Name: "Build"}, {Name: "Test"}, {Name: "Image"}, {Name: "Deploy"}},
			Spark:  model.IntSlice{44, 50, 46, 58, 54, 66, 60, 70, 68, 74}},
	})

	db.Create([]model.Build{
		{BuildNo: "#2841", PipelineName: "payment-api-ci", Status: "ok", Branch: "main", Trigger: "push", Duration: "4m12s", Time: "16:38",
			Stages: mkStages([2]string{"Clone", "ok"}, [2]string{"Build", "ok"}, [2]string{"Test", "ok"}, [2]string{"Image", "ok"}, [2]string{"Deploy", "ok"})},
		{BuildNo: "#2840", PipelineName: "order-svc-cd", Status: "ok", Branch: "release/2.3", Trigger: "merge", Duration: "2m48s", Time: "16:40",
			Stages: mkStages([2]string{"Clone", "ok"}, [2]string{"Build", "ok"}, [2]string{"Test", "ok"}, [2]string{"Image", "ok"}, [2]string{"Deploy", "ok"})},
		{BuildNo: "#2839", PipelineName: "ai-operator-build", Status: "err", Branch: "dev", Trigger: "push", Duration: "1m20s", Time: "16:18",
			Stages: mkStages([2]string{"Clone", "ok"}, [2]string{"Build", "err"}, [2]string{"Test", "pending"}, [2]string{"Image", "pending"}, [2]string{"Deploy", "pending"})},
		{BuildNo: "#2838", PipelineName: "user-svc-ci", Status: "ok", Branch: "main", Trigger: "push", Duration: "3m31s", Time: "16:02",
			Stages: mkStages([2]string{"Clone", "ok"}, [2]string{"Build", "ok"}, [2]string{"Test", "ok"}, [2]string{"Image", "ok"}, [2]string{"Deploy", "ok"})},
		{BuildNo: "#2837", PipelineName: "gateway-envoy-ci", Status: "ok", Branch: "main", Trigger: "schedule", Duration: "6m03s", Time: "15:55",
			Stages: mkStages([2]string{"Clone", "ok"}, [2]string{"Build", "ok"}, [2]string{"Test", "ok"}, [2]string{"Image", "ok"}, [2]string{"Deploy", "ok"})},
		{BuildNo: "#2836", PipelineName: "payment-api-ci", Status: "ok", Branch: "main", Trigger: "push", Duration: "4m05s", Time: "15:30",
			Stages: mkStages([2]string{"Clone", "ok"}, [2]string{"Build", "ok"}, [2]string{"Test", "ok"}, [2]string{"Image", "ok"}, [2]string{"Deploy", "ok"})},
		{BuildNo: "#2835", PipelineName: "notify-worker-ci", Status: "ok", Branch: "main", Trigger: "push", Duration: "2m11s", Time: "15:12",
			Stages: mkStages([2]string{"Clone", "ok"}, [2]string{"Build", "ok"}, [2]string{"Test", "ok"}, [2]string{"Image", "ok"}, [2]string{"Deploy", "ok"})},
	})

	db.Create([]model.Repo{
		{Name: "registry.local/payment", Visibility: "private", Favorite: true, Tags: 12, Size: "2.4 GiB", Pulls: 1843, LastPush: "16:38",
			TagList: []model.RepoTag{
				{Name: "1.8.2", Size: "210 MiB", Pushed: "16:38", VulnCritical: 0, VulnHigh: 0, VulnMedium: 1, VulnLow: 3},
				{Name: "1.8.1", Size: "208 MiB", Pushed: "2d", VulnCritical: 0, VulnHigh: 1, VulnMedium: 2, VulnLow: 4},
				{Name: "latest", Size: "210 MiB", Pushed: "16:38", VulnCritical: 0, VulnHigh: 0, VulnMedium: 1, VulnLow: 3},
			}},
		{Name: "registry.local/order", Visibility: "private", Favorite: true, Tags: 9, Size: "1.8 GiB", Pulls: 1202, LastPush: "16:40",
			TagList: []model.RepoTag{
				{Name: "2.3.0", Size: "196 MiB", Pushed: "16:40", VulnCritical: 0, VulnHigh: 0, VulnMedium: 0, VulnLow: 2},
				{Name: "2.2.5", Size: "194 MiB", Pushed: "5d", VulnCritical: 1, VulnHigh: 2, VulnMedium: 3, VulnLow: 5},
			}},
		{Name: "registry.local/envoy", Visibility: "public", Tags: 6, Size: "980 MiB", Pulls: 5621, LastPush: "3d",
			TagList: []model.RepoTag{
				{Name: "1.29", Size: "162 MiB", Pushed: "3d", VulnCritical: 0, VulnHigh: 0, VulnMedium: 0, VulnLow: 1},
				{Name: "1.28", Size: "158 MiB", Pushed: "20d", VulnCritical: 0, VulnHigh: 1, VulnMedium: 1, VulnLow: 2},
			}},
		{Name: "registry.local/ai-operator", Visibility: "private", Favorite: true, Tags: 4, Size: "3.1 GiB", Pulls: 318, LastPush: "16:18",
			TagList: []model.RepoTag{
				{Name: "0.9.1", Size: "780 MiB", Pushed: "3d", VulnCritical: 0, VulnHigh: 0, VulnMedium: 2, VulnLow: 4},
				{Name: "0.9.0", Size: "775 MiB", Pushed: "11d", VulnCritical: 2, VulnHigh: 3, VulnMedium: 4, VulnLow: 6},
			}},
		{Name: "registry.local/grafana", Visibility: "public", Tags: 8, Size: "1.2 GiB", Pulls: 9044, LastPush: "12d",
			TagList: []model.RepoTag{
				{Name: "11.0", Size: "148 MiB", Pushed: "12d", VulnCritical: 0, VulnHigh: 0, VulnMedium: 1, VulnLow: 2},
			}},
		{Name: "registry.local/es", Visibility: "private", Tags: 5, Size: "4.6 GiB", Pulls: 2210, LastPush: "30d",
			TagList: []model.RepoTag{
				{Name: "8.13", Size: "612 MiB", Pushed: "30d", VulnCritical: 0, VulnHigh: 1, VulnMedium: 2, VulnLow: 3},
			}},
	})

	db.Create([]model.StorageClass{
		{Name: "csi-ssd", Provisioner: "com.tencent.csi.cbs", Reclaim: "Delete", BindMode: "Immediate", IsDefault: true, Volumes: 142},
		{Name: "csi-essd", Provisioner: "com.tencent.csi.cbs", Reclaim: "Retain", BindMode: "Immediate", IsDefault: false, Volumes: 38},
		{Name: "csi-nas", Provisioner: "com.tencent.csi.nas", Reclaim: "Retain", BindMode: "WaitForFirstConsumer", IsDefault: false, Volumes: 21},
		{Name: "local-storage", Provisioner: "kubernetes.io/no-provisioner", Reclaim: "Delete", BindMode: "WaitForFirstConsumer", IsDefault: false, Volumes: 12},
	})

	db.Create([]model.PVC{
		{Name: "data-payment-0", Namespace: "ns-payment", Status: "ok", Capacity: "200Gi", Used: 64, StorageClass: "csi-ssd", Volume: "pvc-7f3a", Access: "RWO", Age: "42d"},
		{Name: "data-order-0", Namespace: "ns-order", Status: "ok", Capacity: "120Gi", Used: 51, StorageClass: "csi-ssd", Volume: "pvc-9c1b", Access: "RWO", Age: "12d"},
		{Name: "es-data", Namespace: "ns-monitor", Status: "ok", Capacity: "500Gi", Used: 78, StorageClass: "csi-essd", Volume: "pvc-2d8e", Access: "RWX", Age: "120d"},
		{Name: "model-cache", Namespace: "ns-ai-train", Status: "warn", Capacity: "1Ti", Used: 93, StorageClass: "csi-essd", Volume: "pvc-5a0f", Access: "RWO", Age: "3d"},
		{Name: "grafana-pv", Namespace: "ns-monitor", Status: "ok", Capacity: "20Gi", Used: 33, StorageClass: "csi-ssd", Volume: "pvc-1b6c", Access: "RWO", Age: "120d"},
		{Name: "shared-nas", Namespace: "ns-gateway", Status: "ok", Capacity: "2Ti", Used: 41, StorageClass: "csi-nas", Volume: "pvc-8e44", Access: "RWX", Age: "88d"},
		{Name: "pending-pvc", Namespace: "ns-order", Status: "pending", Capacity: "50Gi", Used: 0, StorageClass: "csi-ssd", Volume: "—", Access: "RWO", Age: "5m"},
		{Name: "local-audit", Namespace: "kube-system", Status: "ok", Capacity: "100Gi", Used: 22, StorageClass: "local-storage", Volume: "pvc-3f72", Access: "RWO", Age: "188d"},
	})

	db.Create([]model.Service{
		{Name: "payment-svc", Namespace: "ns-payment", Type: "ClusterIP", ClusterIP: "10.96.12.31", Ports: "8080:8080/TCP", Status: "ok"},
		{Name: "order-svc", Namespace: "ns-order", Type: "ClusterIP", ClusterIP: "10.96.12.42", Ports: "8080:8080/TCP", Status: "ok"},
		{Name: "gateway-lb", Namespace: "ns-gateway", Type: "LoadBalancer", ClusterIP: "10.96.13.10", Ports: "80:30080/TCP,443:30443/TCP", Status: "ok"},
		{Name: "grafana-svc", Namespace: "ns-monitor", Type: "NodePort", ClusterIP: "10.96.14.5", Ports: "3000:30300/TCP", Status: "ok"},
		{Name: "es-svc", Namespace: "ns-monitor", Type: "ClusterIP", ClusterIP: "10.96.14.18", Ports: "9200:9200/TCP", Status: "warn"},
		{Name: "ai-infer-lb", Namespace: "ns-ai-train", Type: "LoadBalancer", ClusterIP: "10.96.15.2", Ports: "8000:30800/TCP", Status: "err"},
	})

	db.Create([]model.Ingress{
		{Host: "pay.example.com", Path: "/", Backend: "payment-svc:8080", Tls: true, Status: "ok"},
		{Host: "order.example.com", Path: "/api", Backend: "order-svc:8080", Tls: true, Status: "ok"},
		{Host: "console.example.com", Path: "/", Backend: "gateway-lb:80", Tls: true, Status: "ok"},
		{Host: "grafana.example.com", Path: "/", Backend: "grafana-svc:3000", Tls: true, Status: "ok"},
		{Host: "ai.example.com", Path: "/v1", Backend: "ai-infer-lb:8000", Tls: false, Status: "err"},
	})

	db.Create([]model.Workspace{
		{Name: "ws-payment", Admin: "张伟", Projects: 6, Members: 18, QuotaCpu: 58, QuotaMem: 64, Status: "ok"},
		{Name: "ws-order", Admin: "李娜", Projects: 5, Members: 14, QuotaCpu: 43, QuotaMem: 51, Status: "ok"},
		{Name: "ws-gateway", Admin: "王强", Projects: 3, Members: 9, QuotaCpu: 88, QuotaMem: 60, Status: "warn"},
		{Name: "ws-ai", Admin: "陈晨", Projects: 4, Members: 12, QuotaCpu: 91, QuotaMem: 79, Status: "warn"},
		{Name: "ws-monitor", Admin: "刘洋", Projects: 2, Members: 6, QuotaCpu: 34, QuotaMem: 47, Status: "ok"},
		{Name: "ws-edu", Admin: "赵敏", Projects: 1, Members: 3, QuotaCpu: 12, QuotaMem: 18, Status: "idle"},
	})

	seedPW, _ := crypto.HashPassword(defaultUserPassword)
	db.Create([]model.User{
		{Name: "admin", Role: model.RolePlatformAdmin, Email: "admin@dunhelm.io", Status: "ok", LastLogin: "—", Password: seedPW, Active: true},
		{Name: "思敏", Role: model.RolePlatformAdmin, Email: "simin@dunhelm.io", Status: "ok", LastLogin: "16:40", Password: seedPW},
		{Name: "张伟", Role: model.RoleWorkspaceAdmin, Email: "zhangwei@dunhelm.io", Status: "ok", LastLogin: "15:22", Password: seedPW},
		{Name: "李娜", Role: model.RoleWorkspaceAdmin, Email: "lina@dunhelm.io", Status: "ok", LastLogin: "14:05", Password: seedPW},
		{Name: "王强", Role: model.RoleDeveloper, Email: "wangqiang@dunhelm.io", Status: "ok", LastLogin: "11:48", Password: seedPW},
		{Name: "陈晨", Role: model.RoleDeveloper, Email: "chenchen@dunhelm.io", Status: "warn", LastLogin: "3d前", Password: seedPW},
		{Name: "赵敏", Role: model.RoleViewer, Email: "zhaomin@dunhelm.io", Status: "idle", LastLogin: "12d前", Password: seedPW},
		{Name: "周杰", Role: model.RoleDeveloper, Email: "zhoujie@dunhelm.io", Status: "ok", LastLogin: "09:31", Password: seedPW},
		{Name: "吴磊", Role: model.RoleViewer, Email: "wulei@dunhelm.io", Status: "err", LastLogin: "—", Password: seedPW},
	})

	// 4 个系统内置角色
	db.Create([]model.Role{
		{Slug: model.RolePlatformAdmin, Name: "平台管理员", Description: "超级管理员，拥有所有集群所有权限", IsSystem: true, SortOrder: 10},
		{Slug: model.RoleWorkspaceAdmin, Name: "空间管理员", Description: "单集群命名空间管理（除系统隔离 namespace）", IsSystem: true, SortOrder: 20},
		{Slug: model.RoleDeveloper, Name: "开发者", Description: "单集群读写，可部署与发布", IsSystem: true, SortOrder: 30},
		{Slug: model.RoleViewer, Name: "访客", Description: "只读权限", IsSystem: true, SortOrder: 40},
	})

	db.Create([]model.Credential{
		{Name: "github-platform", Type: "GitHub", Scope: "全局", SecretRef: "gh-token-2f9a", CreatedBy: "思敏", LastUsed: "16:38", Status: "ok"},
		{Name: "gitlab-internal", Type: "GitLab", Scope: "企业空间", SecretRef: "gl-token-7c1d", CreatedBy: "张伟", LastUsed: "15:22", Status: "ok"},
		{Name: "harbor-push", Type: "Harbor", Scope: "全局", SecretRef: "harbor-rw-4b8e", CreatedBy: "思敏", LastUsed: "16:40", Status: "ok"},
		{Name: "gitee-mirror", Type: "Gitee", Scope: "项目", SecretRef: "gte-token-1a3f", CreatedBy: "李娜", LastUsed: "2d前", Status: "idle"},
		{Name: "ssh-deploy-key", Type: "SSH", Scope: "项目", SecretRef: "ssh-rsa-9e02", CreatedBy: "王强", LastUsed: "11:48", Status: "ok"},
		{Name: "dockerhub-pull", Type: "Docker Hub", Scope: "全局", SecretRef: "dh-token-5d6c", CreatedBy: "陈晨", LastUsed: "3d前", Status: "warn"},
		{Name: "kubeconfig-admin", Type: "KubeConfig", Scope: "全局", SecretRef: "kube-admin-0a7b", CreatedBy: "思敏", LastUsed: "09:31", Status: "ok"},
	})

	// 旧 seed 的 audit_log 字段已重构（time.Time + ActorID/ActorName/Action/ResourceType/ResourceName/ClusterID/Result/Detail/IP/UA）；
	// 不再 seed mock 数据，前端会展示真实业务生成的审计记录。
	_ = model.AuditLog{}

	db.Create([]model.Job{
		{Name: "data-migrate-2841", Namespace: "ns-order", Kind: "job", Status: "ok", Completions: 1, Parallelism: 1, Duration: "3m48s", Image: "registry.local/migrate:0.6.1", Age: "2h"},
		{Name: "report-gen-daily", Namespace: "ns-payment", Kind: "job", Status: "ok", Completions: 1, Parallelism: 2, Duration: "11m02s", Image: "registry.local/report:2.0", Age: "8h"},
		{Name: "es-snapshot", Namespace: "ns-monitor", Kind: "job", Status: "ok", Completions: 1, Parallelism: 1, Duration: "6m30s", Image: "registry.local/es-snapshot:1.4", Age: "1d"},
		{Name: "ai-train-eval", Namespace: "ns-ai-train", Kind: "job", Status: "err", Completions: 0, Parallelism: 4, Duration: "2m10s", Image: "registry.local/eval:0.9.1", Age: "5m"},
		{Name: "cache-warmup", Namespace: "ns-gateway", Kind: "job", Status: "running", Completions: 0, Parallelism: 3, Duration: "1m12s", Image: "registry.local/warmup:1.1", Age: "1m"},
	})

	db.Create([]model.Job{
		{Name: "backup-mysql", Namespace: "ns-payment", Kind: "cronjob", Status: "ok", Completions: 1, Parallelism: 1, Duration: "4m", Image: "registry.local/xtrabackup:8.0", Age: "12h", Schedule: sp("0 2 * * *"), Active: ip(0), LastSchedule: sp("02:00"), NextSchedule: sp("明日 02:00")},
		{Name: "log-rotate", Namespace: "ns-order", Kind: "cronjob", Status: "ok", Completions: 1, Parallelism: 1, Duration: "45s", Image: "registry.local/logrotate:1.0", Age: "6h", Schedule: sp("*/30 * * * *"), Active: ip(0), LastSchedule: sp("16:30"), NextSchedule: sp("16:50")},
		{Name: "metrics-collect", Namespace: "ns-monitor", Kind: "cronjob", Status: "ok", Completions: 1, Parallelism: 1, Duration: "1m20s", Image: "registry.local/collector:3.2", Age: "20m", Schedule: sp("*/15 * * * *"), Active: ip(1), LastSchedule: sp("16:45"), NextSchedule: sp("17:00")},
		{Name: "cert-renew", Namespace: "kube-system", Kind: "cronjob", Status: "warn", Completions: 0, Parallelism: 1, Duration: "—", Image: "registry.local/certbot:2.9", Age: "5d", Schedule: sp("0 0 1 * *"), Active: ip(0), LastSchedule: sp("7-01"), NextSchedule: sp("9-01")},
	})
}

// EnsureUsers 幂等地保证内置用户存在。
// 因为 Run 在 clusters 已存在时会提前 return，旧库可能从未 seed 过 users 表；
// 即使已有其他用户（如历史测试账号），也需保证 admin 等内置账号可用。
// 故按 name 逐个排查、缺失则补建（已存在的不动，不覆盖既有密码），避免无人可登录。
// 内置账号与 Run 中 seed 的 9 个用户保持一致。
func EnsureUsers(db *gorm.DB) {
	hash, err := crypto.HashPassword(defaultUserPassword)
	if err != nil {
		return
	}
	for _, u := range []model.User{
		{Name: "admin", Role: model.RolePlatformAdmin, Email: "admin@dunhelm.io", Status: "ok", LastLogin: "—", Password: hash, Active: true},
		{Name: "思敏", Role: model.RolePlatformAdmin, Email: "simin@dunhelm.io", Status: "ok", LastLogin: "16:40", Password: hash},
		{Name: "张伟", Role: model.RoleWorkspaceAdmin, Email: "zhangwei@dunhelm.io", Status: "ok", LastLogin: "15:22", Password: hash},
		{Name: "李娜", Role: model.RoleWorkspaceAdmin, Email: "lina@dunhelm.io", Status: "ok", LastLogin: "14:05", Password: hash},
		{Name: "王强", Role: model.RoleDeveloper, Email: "wangqiang@dunhelm.io", Status: "ok", LastLogin: "11:48", Password: hash},
		{Name: "陈晨", Role: model.RoleDeveloper, Email: "chenchen@dunhelm.io", Status: "warn", LastLogin: "3d前", Password: hash},
		{Name: "赵敏", Role: model.RoleViewer, Email: "zhaomin@dunhelm.io", Status: "idle", LastLogin: "12d前", Password: hash},
		{Name: "周杰", Role: model.RoleDeveloper, Email: "zhoujie@dunhelm.io", Status: "ok", LastLogin: "09:31", Password: hash},
		{Name: "吴磊", Role: model.RoleViewer, Email: "wulei@dunhelm.io", Status: "err", LastLogin: "—", Password: hash},
	} {
		var cnt int64
		db.Model(&model.User{}).Where("name = ?", u.Name).Count(&cnt)
		if cnt > 0 {
			continue // 已存在则跳过，绝不覆盖既有密码
		}
		if err := db.Create(&u).Error; err != nil {
			log.Printf("[seed] EnsureUsers create %s failed: %v", u.Name, err)
		}
	}
}
