package model

// Job 任务 / 定时任务。Kind 区分 job | cronjob，CronJob 专有字段用指针 + omitempty
type Job struct {
	ID          uint    `gorm:"primarykey" json:"-"`
	Name        string  `json:"name"`
	Namespace   string  `json:"namespace"`
	Kind        string  `json:"kind"` // job | cronjob
	Status      string  `json:"status"`
	Completions int     `json:"completions"`
	Parallelism int     `json:"parallelism"`
	Duration    string  `json:"duration"`
	Image       string  `json:"image"`
	Age         string  `json:"age"`
	Schedule    *string `json:"schedule,omitempty"`
	Active      *int    `json:"active,omitempty"`
	LastSchedule *string `json:"lastSchedule,omitempty"`
	NextSchedule *string `json:"nextSchedule,omitempty"`
}
