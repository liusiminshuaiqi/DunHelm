package repository

import (
	"errors"
	"strconv"
	"time"

	"kubehelm/server/internal/crypto"
	"kubehelm/server/internal/model"

	"gorm.io/gorm"
)

// Store 持有数据库连接，封装所有数据访问
type Store struct {
	DB *gorm.DB
}

func New(db *gorm.DB) *Store { return &Store{DB: db} }

// ---------- 集群总览 ----------
func (s *Store) Cluster() (*model.Cluster, error) {
	var c model.Cluster
	if err := s.DB.First(&c).Error; err != nil {
		return nil, err
	}
	return &c, nil
}

// Clusters 集群列表（多集群注册信息）
func (s *Store) Clusters() ([]model.Cluster, error) {
	var list []model.Cluster
	if err := s.DB.Order("id").Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

// CreateCluster 注册新集群（存入 KubeConfig）
func (s *Store) CreateCluster(c *model.Cluster) error { return s.DB.Create(c).Error }

// DeleteCluster 删除已注册集群
func (s *Store) DeleteCluster(id uint) error { return s.DB.Delete(&model.Cluster{}, id).Error }

func (s *Store) Namespaces() ([]model.Namespace, error) {
	var list []model.Namespace
	if err := s.DB.Order("pods desc").Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

func (s *Store) Events() ([]model.Event, error) {
	var list []model.Event
	if err := s.DB.Order("id desc").Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

// ---------- 节点 ----------
func (s *Store) Nodes() ([]model.Node, error) {
	var list []model.Node
	if err := s.DB.Order("id").Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

// ---------- 工作负载 ----------
func (s *Store) Workloads(kind string) ([]model.Workload, error) {
	var list []model.Workload
	q := s.DB.Order("id")
	if kind != "" {
		q = q.Where("kind = ?", kind)
	}
	if err := q.Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

// ---------- 流水线（CI/CD） ----------
// Pipelines 按归属集群列出流水线。cid=0 表示不过滤（全局，仅引擎内部回收等场景使用）。
// 公共模板（is_template=true）始终从列表中排除——模板仅供创建流水线时参考阶段结构，不对用户展示。
func (s *Store) Pipelines(cid uint) ([]model.Pipeline, error) {
	var list []model.Pipeline
	q := s.DB.Order("id")
	if cid != 0 {
		q = q.Where("cluster_id = ? AND COALESCE(is_template, 0) = 0", cid)
	} else {
		q = q.Where("COALESCE(is_template, 0) = 0")
	}
	if err := q.Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

// PipelineByName 按名称（及归属集群）取流水线。cid=0 表示不过滤集群（全局查找）。
func (s *Store) PipelineByName(name string, cid uint) (*model.Pipeline, error) {
	var p model.Pipeline
	q := s.DB.Where("name = ?", name)
	if cid != 0 {
		q = q.Where("cluster_id = ?", cid)
	}
	if err := q.First(&p).Error; err != nil {
		return nil, err
	}
	return &p, nil
}

// CreatePipeline 创建流水线。MavenSettings 由 Pipeline.BeforeSave 钩子加密落库。
func (s *Store) CreatePipeline(p *model.Pipeline) error { return s.DB.Create(p).Error }

// PipelineTemplateByName 全局查找公共模板（is_template=true，不限集群）。
// 用于读路径回退：当前集群找不到流水线时，尝试从公共模板读取，使新集群可参照已有模板创建流水线。
func (s *Store) PipelineTemplateByName(name string) (*model.Pipeline, error) {
	var p model.Pipeline
	if err := s.DB.Where("name = ? AND is_template = ?", name, true).First(&p).Error; err != nil {
		return nil, err
	}
	return &p, nil
}

// UpdatePipeline 整体覆盖式更新（阶段定义 / 配置 / 触发源）。
// mavenSettings 为 *string：非 nil 时更新 maven_settings 列（先 AES-GCM 加密）；
// nil 表示调用方未提供该字段，保留原值不覆盖。加密在此手动完成，因为 Updates(map) 不触发
// Pipeline.BeforeSave 钩子。cid=0 表示按名称全局更新；否则限定归属集群。
func (s *Store) UpdatePipeline(p *model.Pipeline, mavenSettings *string, cid uint) error {
	cols := map[string]interface{}{
		"repo":              p.Repo,
		"branch":            p.Branch,
		"trigger":           p.Trigger,
		"env":               p.Env,
		"stages":            p.Stages,
		"trigger_mode":      p.TriggerMode,
		"default_image":     p.DefaultImage,
		"target_namespace":  p.TargetNamespace,
		"target_workload":   p.TargetWorkload,
		"cluster":           p.Cluster,
		"runtime":           p.Runtime,
		"builder_type":      p.BuilderType,
		"is_template":       p.IsTemplate,
	}
	if mavenSettings != nil {
		enc, err := crypto.Encrypt(*mavenSettings)
		if err != nil {
			return err
		}
		cols["maven_settings"] = enc
	}
	q := s.DB.Model(&model.Pipeline{}).Where("name = ?", p.Name)
	if cid != 0 {
		q = q.Where("cluster_id = ?", cid)
	}
	return q.Updates(cols).Error
}

// ---------- Maven 全局配置（按集群隔离的 settings.xml） ----------
// GetMavenGlobalSettings 读取某集群的 Maven 全局配置（Where cluster_id = ?，AfterFind 已解密）。
// 无记录返回空内容对象（带 ClusterID 便于前端感知当前集群）。
func (s *Store) GetMavenGlobalSettings(cid uint) (*model.MavenGlobalSettings, error) {
	var m model.MavenGlobalSettings
	err := s.DB.Where("cluster_id = ?", cid).First(&m).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return &model.MavenGlobalSettings{ClusterID: cid}, nil
		}
		return nil, err
	}
	return &m, nil
}

// SaveMavenGlobalSettings upsert 某集群的 Maven 全局配置（按 cluster_id 定位，不存在则新建）。
// BeforeSave 钩子加密落库。
func (s *Store) SaveMavenGlobalSettings(content string, cid uint) error {
	var m model.MavenGlobalSettings
	err := s.DB.Where("cluster_id = ?", cid).First(&m).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		m = model.MavenGlobalSettings{
			ClusterID: cid,
			Content:   content,
			UpdatedAt: time.Now().Format("2006-01-02 15:04:05"),
		}
		return s.DB.Create(&m).Error
	} else if err != nil {
		return err
	}
	m.Content = content
	m.UpdatedAt = time.Now().Format("2006-01-02 15:04:05")
	return s.DB.Save(&m).Error
}

// DeletePipeline 删除流水线及其全部构建记录（级联清理）。cid=0 按名称全局删除；否则限定归属集群。
func (s *Store) DeletePipeline(name string, cid uint) error {
	bq := s.DB.Where("pipeline_name = ?", name)
	if cid != 0 {
		bq = bq.Where("cluster_id = ?", cid)
	}
	if err := bq.Delete(&model.Build{}).Error; err != nil {
		return err
	}
	pq := s.DB.Where("name = ?", name)
	if cid != 0 {
		pq = pq.Where("cluster_id = ?", cid)
	}
	return pq.Delete(&model.Pipeline{}).Error
}

// ---------- 构建记录 ----------
// Builds 最近构建（轻量列表；?pipeline= 按流水线过滤，cid 按归属集群过滤）。cid=0 不过滤集群。
func (s *Store) Builds(pipeline string, cid uint) ([]model.Build, error) {
	var list []model.Build
	q := s.DB.Order("id desc")
	if pipeline != "" {
		q = q.Where("pipeline_name = ?", pipeline)
	}
	if cid != 0 {
		q = q.Where("cluster_id = ?", cid)
	}
	if err := q.Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

// BuildsPaginated 构建记录分页（?pipeline= 过滤；offset/pageSize 分页）。cid 按归属集群过滤。
// 返回 (total, list, error)；list 按 id 倒序（最新在前）。
func (s *Store) BuildsPaginated(pipeline string, cid uint, offset, pageSize int) (int64, []model.Build, error) {
	var total int64
	q := s.DB.Model(&model.Build{})
	if pipeline != "" {
		q = q.Where("pipeline_name = ?", pipeline)
	}
	if cid != 0 {
		q = q.Where("cluster_id = ?", cid)
	}
	if err := q.Count(&total).Error; err != nil {
		return 0, nil, err
	}
	var list []model.Build
	if err := q.Order("id desc").Offset(offset).Limit(pageSize).Find(&list).Error; err != nil {
		return 0, nil, err
	}
	return total, list, nil
}

// RecentBuildStatuses 取某条流水线最近 limit 条构建的状态字符串（最新在前；status 字段原样返回）。
// 用于流水线卡片上的「构建历史条」可视化（每格 = 一次构建，按状态填色）。cid 按归属集群过滤。
func (s *Store) RecentBuildStatuses(pipeline string, limit int, cid uint) ([]string, error) {
	if limit <= 0 {
		return []string{}, nil
	}
	q := s.DB.Model(&model.Build{}).Order("id desc")
	if pipeline != "" {
		q = q.Where("pipeline_name = ?", pipeline)
	}
	if cid != 0 {
		q = q.Where("cluster_id = ?", cid)
	}
	var statuses []string
	if err := q.Limit(limit).Pluck("status", &statuses).Error; err != nil {
		return nil, err
	}
	return statuses, nil
}

// ---------- 构建保留条数（平台级全局配置） ----------
// GetBuildRetention 读取保留条数（单行 ID=1）。无记录或非法值默认返回 10。
func (s *Store) GetBuildRetention() (int, error) {
	var m model.BuildRetentionGlobal
	err := s.DB.First(&m, uint(1)).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return 10, nil
		}
		return 10, err
	}
	if m.Keep < 1 {
		return 10, nil
	}
	return m.Keep, nil
}

// SaveBuildRetention 保存保留条数（upsert ID=1，下限保护为 1）。
func (s *Store) SaveBuildRetention(keep int) error {
	if keep < 1 {
		keep = 1
	}
	m := model.BuildRetentionGlobal{
		ID:        1,
		Keep:      keep,
		UpdatedAt: time.Now().Format("2006-01-02 15:04:05"),
	}
	return s.DB.Save(&m).Error
}

// PurgeOldBuilds 按流水线保留最近 keep 条，删除更旧的记录（含阶段日志）。keep<=0 视为不清理。
// cid 限定归属集群（cid=0 则该流水线所有集群的旧记录一起清理）。
func (s *Store) PurgeOldBuilds(pipeline string, keep int, cid uint) error {
	if keep <= 0 || pipeline == "" {
		return nil
	}
	q := s.DB.Model(&model.Build{}).Where("pipeline_name = ?", pipeline)
	if cid != 0 {
		q = q.Where("cluster_id = ?", cid)
	}
	var ids []uint
	if err := q.Order("id asc").Pluck("id", &ids).Error; err != nil {
		return err
	}
	if len(ids) <= keep {
		return nil
	}
	toDelete := ids[:len(ids)-keep]
	return s.DB.Where("id IN ?", toDelete).Delete(&model.Build{}).Error
}

// PurgeAllOldBuilds 对所有流水线套用保留条数（降低配置后立即生效，跨流水线批量清理）。
func (s *Store) PurgeAllOldBuilds(keep int) error {
	if keep <= 0 {
		return nil
	}
	var names []string
	if err := s.DB.Model(&model.Build{}).Distinct("pipeline_name").Pluck("pipeline_name", &names).Error; err != nil {
		return err
	}
	for _, n := range names {
		if err := s.PurgeOldBuilds(n, keep, 0); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) BuildByNo(no string) (*model.Build, error) {
	var b model.Build
	if err := s.DB.Where("build_no = ?", no).First(&b).Error; err != nil {
		return nil, err
	}
	return &b, nil
}

func (s *Store) BuildByID(id uint) (*model.Build, error) {
	var b model.Build
	if err := s.DB.First(&b, id).Error; err != nil {
		return nil, err
	}
	return &b, nil
}

// PatchPipeline 局部更新流水线字段（最后状态 / 耗时 / 最近运行等）。cid=0 按名称全局更新；否则限定归属集群。
func (s *Store) PatchPipeline(name string, cid uint, cols map[string]interface{}) error {
	q := s.DB.Model(&model.Pipeline{}).Where("name = ?", name)
	if cid != 0 {
		q = q.Where("cluster_id = ?", cid)
	}
	return q.Updates(cols).Error
}

// CreateBuild 写入一条构建记录。若调用方未指定归属集群，则尝试从流水线定义继承（按名称查找）。
func (s *Store) CreateBuild(b *model.Build) error {
	if b.ClusterID == 0 && b.PipelineName != "" {
		var p model.Pipeline
		if err := s.DB.Where("name = ?", b.PipelineName).First(&p).Error; err == nil {
			b.ClusterID = p.ClusterID
		}
	}
	return s.DB.Create(b).Error
}

func (s *Store) UpdateBuild(b *model.Build) error {
	return s.DB.Save(b).Error
}

// NextBuildNo 返回下一个构建编号（续接历史最大号；无记录则从 #2842 起）
func (s *Store) NextBuildNo() (string, error) {
	var max int
	if err := s.DB.Model(&model.Build{}).
		Select("COALESCE(MAX(CAST(REPLACE(build_no, '#', '') AS INTEGER)), 2841)").
		Scan(&max).Error; err != nil {
		return "", err
	}
	return "#" + strconv.Itoa(max+1), nil
}

// ---------- 镜像仓库 ----------
func (s *Store) Repos() ([]model.Repo, error) {
	var list []model.Repo
	if err := s.DB.Preload("TagList").Order("id").Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

func (s *Store) ToggleFavorite(id uint) error {
	var r model.Repo
	if err := s.DB.First(&r, id).Error; err != nil {
		return err
	}
	r.Favorite = !r.Favorite
	return s.DB.Save(&r).Error
}

// ---------- 平台治理 ----------
func (s *Store) Workspaces() ([]model.Workspace, error) {
	var list []model.Workspace
	if err := s.DB.Order("id").Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

func (s *Store) Users() ([]model.User, error) {
	var list []model.User
	if err := s.DB.Order("id").Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

// UserByID 按 ID 取用户（供登录/权限回填）
func (s *Store) UserByID(id uint) (*model.User, error) {
	var u model.User
	if err := s.DB.First(&u, id).Error; err != nil {
		return nil, err
	}
	return &u, nil
}

// UserByName 按 name 取用户（兼容旧 JWT sub 字段）
func (s *Store) UserByName(name string) (*model.User, error) {
	var u model.User
	if err := s.DB.Where("name = ?", name).First(&u).Error; err != nil {
		return nil, err
	}
	return &u, nil
}

// UserByEmail 按邮箱查找用户（登录支持邮箱）
func (s *Store) UserByEmail(email string) (*model.User, error) {
	var u model.User
	if err := s.DB.Where("email = ?", email).First(&u).Error; err != nil {
		return nil, err
	}
	return &u, nil
}

// UserByLogin 登录入口：先按 name 查，查不到再按 email 查
func (s *Store) UserByLogin(login string) (*model.User, error) {
	if u, err := s.UserByName(login); err == nil && u != nil {
		return u, nil
	}
	return s.UserByEmail(login)
}

// CreateUser 创建用户（User 默认 Active=true）
func (s *Store) CreateUser(u *model.User) error {
	if u.CreatedAt == "" {
		u.CreatedAt = time.Now().Format("2006-01-02 15:04:05")
	}
	return s.DB.Create(u).Error
}

// UpdateUser 改用户基本信息（不含角色与权限）
func (s *Store) UpdateUser(id uint, fields map[string]interface{}) error {
	return s.DB.Model(&model.User{}).Where("id = ?", id).Updates(fields).Error
}

// DeleteUser 删除用户（级联清理 UserClusterPermission，不需 SQL 级联，repository 内手动级联）
func (s *Store) DeleteUser(id uint) error {
	if err := s.DB.Where("user_id = ?", id).Delete(&model.UserClusterPermission{}).Error; err != nil {
		return err
	}
	return s.DB.Delete(&model.User{}, id).Error
}

// SetUserActive 启/禁用用户
func (s *Store) SetUserActive(id uint, active bool) error {
	return s.DB.Model(&model.User{}).Where("id = ?", id).Update("active", active).Error
}

// ---------- 角色（RBAC） ----------
func (s *Store) Roles() ([]model.Role, error) {
	var list []model.Role
	if err := s.DB.Order("sort_order, id").Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

func (s *Store) RoleBySlug(slug string) (*model.Role, error) {
	var r model.Role
	if err := s.DB.Where("slug = ?", slug).First(&r).Error; err != nil {
		return nil, err
	}
	return &r, nil
}

func (s *Store) CreateRole(r *model.Role) error { return s.DB.Create(r).Error }

// UpdateRole 更新角色（仅 name/description 可改）
func (s *Store) UpdateRole(slug string, fields map[string]interface{}) error {
	return s.DB.Model(&model.Role{}).Where("slug = ?", slug).Updates(fields).Error
}

// DeleteRole 删除角色（仅在 IsSystem=false 且无用户引用时允许）
func (s *Store) DeleteRole(slug string) (int64, error) {
	res := s.DB.Where("slug = ? AND is_system = 0", slug).Delete(&model.Role{})
	return res.RowsAffected, res.Error
}

// ---------- 用户-集群权限 ----------
// UserPermissions 列出某用户的所有集群授权
func (s *Store) UserPermissions(userID uint) ([]model.UserClusterPermission, error) {
	var list []model.UserClusterPermission
	if err := s.DB.Where("user_id = ?", userID).Order("cluster_id").Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

// UserPermissionByCluster 查某用户对某集群的授权
func (s *Store) UserPermissionByCluster(userID, clusterID uint) (*model.UserClusterPermission, error) {
	var p model.UserClusterPermission
	if err := s.DB.Where("user_id = ? AND cluster_id = ?", userID, clusterID).First(&p).Error; err != nil {
		return nil, err
	}
	return &p, nil
}

// AssignUserPermission 分配/覆盖（按 user_id+cluster_id 唯一）
func (s *Store) AssignUserPermission(p *model.UserClusterPermission) error {
	now := time.Now().Format("2006-01-02 15:04:05")
	if p.CreatedAt == "" {
		p.CreatedAt = now
	}
	p.UpdatedAt = now
	// Upsert by (user_id, cluster_id)
	var exist model.UserClusterPermission
	err := s.DB.Where("user_id = ? AND cluster_id = ?", p.UserID, p.ClusterID).First(&exist).Error
	if err == nil {
		p.ID = exist.ID
		p.CreatedAt = exist.CreatedAt
		return s.DB.Save(p).Error
	}
	return s.DB.Create(p).Error
}

// RevokeUserPermission 撤销某用户对某集群的授权
func (s *Store) RevokeUserPermission(userID, clusterID uint) error {
	return s.DB.Where("user_id = ? AND cluster_id = ?", userID, clusterID).Delete(&model.UserClusterPermission{}).Error
}

// MyClusters 当前用户可访问的集群 id 列表（platform-admin 走专门接口绕过）
func (s *Store) MyClusters(userID uint) ([]uint, error) {
	var list []model.UserClusterPermission
	if err := s.DB.Where("user_id = ?", userID).Find(&list).Error; err != nil {
		return nil, err
	}
	ids := make([]uint, 0, len(list))
	for _, p := range list {
		ids = append(ids, p.ClusterID)
	}
	return ids, nil
}

// ---------- 菜单权限 ----------
// RoleMenus 查某角色全部可见菜单 key
func (s *Store) RoleMenus(roleSlug string) ([]string, error) {
	var rows []model.MenuPermission
	if err := s.DB.Where("role_slug = ?", roleSlug).Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]string, 0, len(rows))
	for _, r := range rows {
		out = append(out, r.MenuKey)
	}
	return out, nil
}

// SetRoleMenus 覆盖式设置（先全删后插）
func (s *Store) SetRoleMenus(roleSlug string, menus []string) error {
	tx := s.DB.Begin()
	if err := tx.Where("role_slug = ?", roleSlug).Delete(&model.MenuPermission{}).Error; err != nil {
		tx.Rollback()
		return err
	}
	for _, m := range menus {
		p := model.MenuPermission{
			RoleSlug:  roleSlug,
			MenuKey:   m,
			CreatedAt: time.Now().Format("2006-01-02 15:04:05"),
		}
		if err := tx.Create(&p).Error; err != nil {
			tx.Rollback()
			return err
		}
	}
	return tx.Commit().Error
}

// MyMenus 取当前用户可见的菜单集（platform-admin 走 handler 单独处理）
func (s *Store) MyMenus(userID uint) ([]string, error) {
	var u model.User
	if err := s.DB.First(&u, userID).Error; err != nil {
		return nil, err
	}
	return s.RoleMenus(u.Role)
}

func (s *Store) Credentials() ([]model.Credential, error) {
	var list []model.Credential
	if err := s.DB.Order("id").Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

// ---------- 镜像仓库连接（多仓库） ----------
// RegistryEndpoints 按归属集群列出连接。cid=0 表示不过滤（全局）。
func (s *Store) RegistryEndpoints(cid uint) ([]model.RegistryEndpoint, error) {
	var list []model.RegistryEndpoint
	q := s.DB.Order("id")
	if cid != 0 {
		q = q.Where("cluster_id = ?", cid)
	}
	if err := q.Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

func (s *Store) CreateRegistryEndpoint(e *model.RegistryEndpoint) error {
	return s.DB.Create(e).Error
}

// DeleteRegistryEndpoint 按 id（及归属集群）删除连接。cid=0 按 id 全局删除；否则限定归属集群。
func (s *Store) DeleteRegistryEndpoint(id uint, cid uint) error {
	q := s.DB.Where("id = ?", id)
	if cid != 0 {
		q = q.Where("cluster_id = ?", cid)
	}
	return q.Delete(&model.RegistryEndpoint{}).Error
}

func (s *Store) CreateCredential(c *model.Credential) error {
	return s.DB.Create(c).Error
}

func (s *Store) DeleteCredential(id uint) error {
	return s.DB.Delete(&model.Credential{}, id).Error
}

// ---------- 写入：创建类操作 ----------
func (s *Store) CreateWorkspace(w *model.Workspace) error { return s.DB.Create(w).Error }
func (s *Store) CreateStorageClass(sc *model.StorageClass) error {
	return s.DB.Create(sc).Error
}
func (s *Store) CreatePVC(p *model.PVC) error        { return s.DB.Create(p).Error }
func (s *Store) CreateService(svc *model.Service) error { return s.DB.Create(svc).Error }
func (s *Store) CreateIngress(i *model.Ingress) error  { return s.DB.Create(i).Error }
func (s *Store) CreateRepo(r *model.Repo) error        { return s.DB.Create(r).Error }

func (s *Store) AuditLogs() ([]model.AuditLog, error) {
	var list []model.AuditLog
	if err := s.DB.Order("id desc").Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

// ---------- 审计日志 ----------
// CreateAuditLog 写入一条审计
func (s *Store) CreateAuditLog(a *model.AuditLog) error {
	return s.DB.Create(a).Error
}

// AuditFilter 审计多维筛选条件
type AuditFilter struct {
	ActorName    string    // 模糊匹配
	Action       string    // 精确匹配（含 . 分隔路径）
	ResourceType string    // user / role / cluster / pipeline / credential
	ResourceName string    // 模糊匹配
	ClusterID    uint      // 0 = 不限
	Result       string    // ok / denied / error；空=不限
	From         time.Time // 起始时间（含），零值=不限
	To           time.Time // 截止时间（不含），零值=不限
	Limit        int       // 默认 100，最大 500
	Offset       int       // 默认 0
}

// AuditQuery 多维筛选 + 分页
func (s *Store) AuditQuery(f AuditFilter) ([]model.AuditLog, error) {
	q := s.DB.Model(&model.AuditLog{})
	if f.ActorName != "" {
		q = q.Where("actor_name LIKE ?", "%"+f.ActorName+"%")
	}
	if f.Action != "" {
		q = q.Where("action = ?", f.Action)
	}
	if f.ResourceType != "" {
		q = q.Where("resource_type = ?", f.ResourceType)
	}
	if f.ResourceName != "" {
		q = q.Where("resource_name LIKE ?", "%"+f.ResourceName+"%")
	}
	if f.ClusterID != 0 {
		q = q.Where("cluster_id = ?", f.ClusterID)
	}
	if f.Result != "" {
		q = q.Where("result = ?", f.Result)
	}
	if !f.From.IsZero() {
		q = q.Where("time >= ?", f.From)
	}
	if !f.To.IsZero() {
		q = q.Where("time < ?", f.To)
	}
	limit := f.Limit
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	var list []model.AuditLog
	if err := q.Order("id desc").Limit(limit).Offset(f.Offset).Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

// AuditCount 统计总数（用于分页/summary）
func (s *Store) AuditCount(f AuditFilter) (int64, error) {
	q := s.DB.Model(&model.AuditLog{})
	if f.ActorName != "" {
		q = q.Where("actor_name LIKE ?", "%"+f.ActorName+"%")
	}
	if f.Action != "" {
		q = q.Where("action = ?", f.Action)
	}
	if f.ResourceType != "" {
		q = q.Where("resource_type = ?", f.ResourceType)
	}
	if f.ResourceName != "" {
		q = q.Where("resource_name LIKE ?", "%"+f.ResourceName+"%")
	}
	if f.ClusterID != 0 {
		q = q.Where("cluster_id = ?", f.ClusterID)
	}
	if f.Result != "" {
		q = q.Where("result = ?", f.Result)
	}
	if !f.From.IsZero() {
		q = q.Where("time >= ?", f.From)
	}
	if !f.To.IsZero() {
		q = q.Where("time < ?", f.To)
	}
	var n int64
	if err := q.Count(&n).Error; err != nil {
		return 0, err
	}
	return n, nil
}

// AuditByID 单查详情
func (s *Store) AuditByID(id uint) (*model.AuditLog, error) {
	var a model.AuditLog
	if err := s.DB.First(&a, id).Error; err != nil {
		return nil, err
	}
	return &a, nil
}

// AuditSummary 聚合统计：今日 / 总数 / 拒绝数 / 敏感操作数 / Top actors
type AuditSummary struct {
	Total         int64            `json:"total"`
	Today         int64            `json:"today"`
	Denied        int64            `json:"denied"`
	Sensitive     int64            `json:"sensitive"`
	TopActors     []AuditActorStat `json:"topActors"`
	RecentSensitive []model.AuditLog `json:"recentSensitive"`
}

// AuditActorStat Top actor 统计
type AuditActorStat struct {
	ActorName string `json:"actorName"`
	Count     int64  `json:"count"`
}

// AuditComputeSummary 计算统计（直接 DB 聚合）
func (s *Store) AuditComputeSummary() (*AuditSummary, error) {
	out := &AuditSummary{}
	var err error

	if out.Total, err = s.AuditCount(AuditFilter{}); err != nil {
		return nil, err
	}
	// 今日（本地时区 00:00:00 起）
	now := time.Now()
	midnight := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	if out.Today, err = s.AuditCount(AuditFilter{From: midnight}); err != nil {
		return nil, err
	}
	// 拒绝
	if out.Denied, err = s.AuditCount(AuditFilter{Result: "denied"}); err != nil {
		return nil, err
	}
	// 敏感：role.* / permission.* / cluster.* / registry.* / pipeline.delete / credential.* / user.*
	var sensitive int64
	sensitiveSQL := "action LIKE ? OR action LIKE ? OR action LIKE ? OR action LIKE ? OR action LIKE ? OR action = ? OR action LIKE ?"
	sensitiveArgs := []interface{}{"user.%", "role.%", "permission.%", "cluster.%", "registry.%", "pipeline.delete", "credential.%"}
	if err := s.DB.Model(&model.AuditLog{}).Where(sensitiveSQL, sensitiveArgs...).Count(&sensitive).Error; err != nil {
		return nil, err
	}
	out.Sensitive = sensitive

	// Top 5 actors
	type row struct {
		ActorName string
		Count     int64
	}
	var rows []row
	if err := s.DB.Model(&model.AuditLog{}).
		Select("actor_name, COUNT(*) as count").
		Where("actor_name <> ''").
		Group("actor_name").
		Order("count desc").
		Limit(5).
		Scan(&rows).Error; err != nil {
		return nil, err
	}
	for _, r := range rows {
		out.TopActors = append(out.TopActors, AuditActorStat{ActorName: r.ActorName, Count: r.Count})
	}

	// 最近 5 条敏感操作
	var sensList []model.AuditLog
	if err := s.DB.Model(&model.AuditLog{}).
		Where(sensitiveSQL, sensitiveArgs...).
		Order("id desc").Limit(5).Find(&sensList).Error; err != nil {
		return nil, err
	}
	out.RecentSensitive = sensList

	return out, nil
}

// ---------- 网络与存储 ----------
func (s *Store) StorageClasses() ([]model.StorageClass, error) {
	var list []model.StorageClass
	if err := s.DB.Order("id").Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

func (s *Store) PVCs() ([]model.PVC, error) {
	var list []model.PVC
	if err := s.DB.Order("id").Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

func (s *Store) Services() ([]model.Service, error) {
	var list []model.Service
	if err := s.DB.Order("id").Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

func (s *Store) Ingresses() ([]model.Ingress, error) {
	var list []model.Ingress
	if err := s.DB.Order("id").Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}

// ---------- Job / CronJob ----------
func (s *Store) Jobs(kind string) ([]model.Job, error) {
	var list []model.Job
	q := s.DB.Order("id")
	if kind != "" {
		q = q.Where("kind = ?", kind)
	}
	if err := q.Find(&list).Error; err != nil {
		return nil, err
	}
	return list, nil
}
