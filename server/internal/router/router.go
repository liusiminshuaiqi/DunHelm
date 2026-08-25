package router

import (
	"net/http"
	"time"

	"kubehelm/server/internal/audit"
	"kubehelm/server/internal/crypto"
	"kubehelm/server/internal/handler"
	"kubehelm/server/internal/ci"
	"kubehelm/server/internal/k8s"
	"kubehelm/server/internal/middleware"
	"kubehelm/server/internal/model"
	"kubehelm/server/internal/repository"

	"github.com/gin-gonic/gin"
)

// New 构建 gin 引擎并注册全部路由
func New(s *repository.Store, k *k8s.Manager, c *ci.Engine) *gin.Engine {
	r := gin.Default()
	r.Use(middleware.CORS())

	h := handler.New(s, k, c)
	api := r.Group("/api")
	{
		api.GET("/health", func(c *gin.Context) {
			c.JSON(200, gin.H{"status": "ok"})
		})

		// 登录：校验账号密码（bcrypt），返回 JWT。无鉴权（自身就是鉴权入口）
		api.POST("/login", func(c *gin.Context) {
			var body struct {
				Username string `json:"username"`
				Password string `json:"password"`
			}
			_ = c.ShouldBindJSON(&body)
			if body.Username == "" {
				body.Username = "admin"
			}
			// 统一失败响应（避免泄露用户是否存在）
			fail := func(detail string) {
				audit.RecordFromCtx(c, s, audit.Actor{ID: 0, Name: body.Username}, model.AuditLoginFailed, "platform", body.Username, 0, "denied", detail)
				c.JSON(http.StatusUnauthorized, gin.H{"error": "用户名或密码错误"})
			}
			u, err := s.UserByLogin(body.Username)
			if err != nil || u == nil {
				fail("user not found")
				return
			}
			if !u.Active {
				audit.RecordFromCtx(c, s, audit.Actor{ID: u.ID, Name: u.Name}, model.AuditLoginFailed, "platform", u.Name, 0, "denied", "user disabled")
				c.JSON(http.StatusForbidden, gin.H{"error": "账号已被禁用，请联系管理员"})
				return
			}
			if u.Status == "locked" {
				audit.RecordFromCtx(c, s, audit.Actor{ID: u.ID, Name: u.Name}, model.AuditLoginFailed, "platform", u.Name, 0, "denied", "user locked")
				c.JSON(http.StatusForbidden, gin.H{"error": "账号已被锁定"})
				return
			}
			if !crypto.CheckPassword(body.Password, u.Password) {
				fail("wrong password")
				return
			}
			token, _ := middleware.GenerateToken(u.Name, u.ID, u.Role)
			// 更新最后登录时间
			s.DB.Model(&model.User{}).Where("id = ?", u.ID).Update("last_login", time.Now().Format("2006-01-02 15:04:05"))
			// 登录审计：每次成功登录记一条 platform 级审计（含角色快照）
			audit.RecordFromCtx(c, s, audit.Actor{ID: u.ID, Name: u.Name}, model.AuditLogin, "platform", u.Name, 0, "ok", "role="+u.Role)
			c.JSON(200, gin.H{"token": token, "uid": u.ID, "role": u.Role, "username": u.Name})
		})
	}

	// 以下接口均要求 JWT 鉴权（health / login 除外）
	api.Use(middleware.JWT(s))
	{
		// 当前用户可访问的集群（用于顶部下拉，受限菜单）
		api.GET("/clusters/me", h.MyClusters)

		// 当前用户可见菜单（用于 Sidebar 过滤，受限菜单）
		api.GET("/me/menus", h.MyMenus)

		// 资源类接口（需 cluster 权限）
		res := api.Group("")
		res.Use(middleware.RequireClusterAccess(s))
		{
			// 集群总览 / 节点（核心只读：?cluster= 指定集群）
			res.GET("/overview", h.Overview)
			res.GET("/nodes", h.Nodes)
			res.GET("/node-pods", h.NodePods)
			res.GET("/namespaces", h.Namespaces)

			// 节点监控数据源：node-exporter（磁盘）+ metrics-server（CPU/内存）一键安装与状态
			res.POST("/node-exporter/install", h.NodeExporterInstall)
			res.GET("/node-exporter/status", h.NodeExporterStatus)
			res.POST("/metrics-server/install", h.MetricsServerInstall)
			res.GET("/metrics-server/status", h.MetricsServerStatus)

			// 工作负载 / Job
			res.GET("/workloads", h.Workloads)
			res.POST("/workloads", h.CreateWorkload)
			res.GET("/workloads/:ns/:name", h.WorkloadSpec)
			res.PUT("/workloads/:ns/:name", h.UpdateWorkload)
			res.GET("/workloads/:ns/:name/yaml", h.WorkloadYAML)
			res.GET("/jobs", h.Jobs)

			// 工作负载详情：Pod 列表 / 日志流 / 控制台终端
			res.GET("/workload-pods", h.WorkloadPods)
			res.GET("/pod-logs", h.PodLogs)
			res.GET("/pod-exec", h.PodExec)

			// 工作负载写操作：发布历史 / 暂停·重启·升级·回滚（作用于真实集群）
			res.GET("/workload-revisions", h.WorkloadRevisions)
			res.POST("/workload-action", h.WorkloadAction)

			// 流水线（自研 CI 引擎）
			res.GET("/pipelines", h.Pipelines)
			res.POST("/pipelines", h.CreatePipeline)
			res.GET("/pipelines/:name", h.PipelineDetail)
			res.PUT("/pipelines/:name", h.UpdatePipeline)
			res.PATCH("/pipelines/:name/stages", h.UpdatePipelineStages)
			res.PATCH("/pipelines/:name/source", h.SetPipelineSource)
			res.GET("/pipelines/:name/yaml", h.PipelineYAML)
			res.PUT("/pipelines/:name/yaml", h.PipelineYAML)
			res.DELETE("/pipelines/:name", h.DeletePipeline)
			res.PUT("/pipelines/:name/template", h.SetPipelineTemplate)
			res.POST("/pipelines/:name/run", h.RunPipeline)
			res.POST("/pipelines/git-probe", h.GitProbe)
			res.POST("/pipelines/:name/stages/:stage/upload", h.UploadPipeline)
			res.GET("/builds", h.Builds)
			res.GET("/builds/:no", h.BuildDetail)
			res.POST("/builds/:no/abort", h.AbortBuild)

			// Maven 构建配置（集群级）
			res.GET("/maven-settings", h.GetMavenSettings)
			res.PUT("/maven-settings", h.SaveMavenSettings)

			// 镜像仓库
			res.GET("/repos", h.Repos)
			res.POST("/repos", h.CreateRepo)
			res.POST("/repos/:id/favorite", h.ToggleFavorite)

			// 镜像仓库（多注册中心连接 + Harbor 真实对接）
			res.GET("/registries", h.Registries)
			res.POST("/registries", h.CreateRegistry)
			res.PUT("/registries/:id", h.UpdateRegistry)
			res.DELETE("/registries/:id", h.DeleteRegistry)
			res.POST("/registries/test", h.TestRegistry)
			res.GET("/registry/projects", h.RegistryProjects)
			res.POST("/registry/projects", h.RegistryCreateProject)
			res.PUT("/registry/projects", h.RegistryUpdateProject)
			res.DELETE("/registry/projects", h.RegistryDeleteProject)
			res.GET("/registry/repos", h.RegistryRepos)
			res.GET("/registry/artifacts", h.RegistryArtifacts)
			res.GET("/registry/project-usage", h.RegistryProjectUsage)
			res.DELETE("/registry/artifacts", h.RegistryDeleteArtifact)
			res.DELETE("/registry/repositories", h.RegistryDeleteRepository)

			// 配置管理（ConfigMap）
			res.GET("/configmaps", h.ConfigMaps)
			res.GET("/configmaps/get", h.ConfigMap)
			res.PUT("/configmaps/update", h.ConfigMapUpdate)

			// 网络与存储
			res.GET("/storage-classes", h.StorageClasses)
			res.POST("/storage-classes", h.CreateStorageClass)
			res.GET("/storage-classes/:name", h.StorageClassDetail)
			res.PUT("/storage-classes/:name", h.UpdateStorageClass)
			res.GET("/pvcs", h.PVCs)
			res.POST("/pvcs", h.CreatePVC)
			res.GET("/pvcs/:ns/:name", h.PVCDetail)
			res.PUT("/pvcs/:ns/:name", h.UpdatePVC)
			res.DELETE("/pvcs/:ns/:name", h.DeletePVC)
			res.DELETE("/pvs/:name", h.DeletePV)
			res.DELETE("/storage-classes/:name", h.DeleteStorageClass)
			res.GET("/pvs", h.PVs)
			res.POST("/pvs", h.CreatePV)
			res.GET("/pvs/:name", h.PVDetail)
			res.PUT("/pvs/:name", h.UpdatePV)
			res.GET("/storage-summary", h.StorageSummary)
			res.GET("/services", h.Services)
			res.POST("/services", h.CreateService)
			res.PUT("/services/:ns/:name", h.UpdateService)
			res.DELETE("/services/:ns/:name", h.DeleteService)
			res.GET("/ingresses", h.Ingresses)
			res.POST("/ingresses", h.CreateIngress)
			res.PUT("/ingresses/:ns/:name", h.UpdateIngress)
			res.DELETE("/ingresses/:ns/:name", h.DeleteIngress)
			res.POST("/ingresses/tls-cert", h.GenerateIngressTLSCert)

			// 凭证（cluster 决定走真实集群 K8s Secret 还是本地 DB）
			res.GET("/credentials", h.Credentials)
			res.POST("/credentials", h.CreateCredential)
			res.DELETE("/credentials", h.DeleteCredentialCluster)
			res.DELETE("/credentials/:id", h.DeleteCredential)
		}

		// 平台级管理（无 cluster 概念；管理接口本身仅 platform-admin 可见）
		admin := api.Group("")
		admin.Use(middleware.RequireRole(model.RolePlatformAdmin))
		{
			admin.GET("/users", h.Users)
			admin.POST("/users", h.CreateUser)
			admin.GET("/users/:id", h.GetUser)
			admin.PUT("/users/:id", h.UpdateUser)
			admin.DELETE("/users/:id", h.DeleteUser)
			admin.PATCH("/users/:id/status", h.SetUserStatus)
			admin.PATCH("/users/:id/active", h.SetUserActive)
		admin.POST("/users/:id/password", h.ResetUserPassword)
			admin.GET("/users/:id/permissions", h.UserPermissions)
			admin.POST("/users/:id/permissions", h.AssignUserPermission)
			admin.DELETE("/users/:id/permissions/:clusterId", h.RevokeUserPermission)
			admin.GET("/roles", h.Roles)
			admin.POST("/roles", h.CreateRole)
			admin.PUT("/roles/:slug", h.UpdateRole)
			admin.DELETE("/roles/:slug", h.DeleteRole)
			admin.GET("/roles/:slug/menu-permissions", h.RoleMenuPermissions)
			admin.PUT("/roles/:slug/menu-permissions", h.SetRoleMenuPermissions)
			admin.GET("/clusters", h.Clusters)
			admin.POST("/clusters", h.CreateCluster)
			admin.DELETE("/clusters/:id", h.DeleteCluster)
		}

		// 平台级只读 / 公共（任何登录用户可访问）
		api.GET("/workspaces", h.Workspaces)
		api.POST("/workspaces", h.CreateWorkspace)
		api.GET("/audit", h.Audit)
		api.GET("/audit/summary", h.AuditSummary)
		// 导出通过 ?export=csv|json 触发（在 h.Audit 内部分流，避免与 /audit/:id 路由冲突）
		api.GET("/audit/:id", h.AuditDetail)

		// 平台级全局配置（可由平台管理员管理）
		api.GET("/settings/build-retention", h.GetBuildRetention)
		api.PUT("/settings/build-retention", h.SaveBuildRetention)
	}
	return r
}
