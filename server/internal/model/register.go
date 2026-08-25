package model

// AllModels 返回全部需 AutoMigrate 的模型，供 db.Init 使用
func AllModels() []interface{} {
	return []interface{}{
		&Cluster{}, &Namespace{}, &Event{},
		&Node{}, &Workload{},
		&Pipeline{}, &Build{},
		&Repo{}, &RepoTag{},
		&StorageClass{}, &PVC{}, &Service{}, &Ingress{},
		&Workspace{}, &User{}, &Credential{}, &AuditLog{},
		&Job{}, &RegistryEndpoint{},
		&MavenGlobalSettings{},
		&BuildRetentionGlobal{},
		&Role{}, &UserClusterPermission{},
		&MenuPermission{},
	}
}
