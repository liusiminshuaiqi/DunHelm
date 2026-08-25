package model

import (
	"database/sql/driver"
	"encoding/json"
	"errors"
)

// StringSlice 序列化为 JSON 文本，兼容 SQLite / MySQL 的 text 列
type StringSlice []string

func (s StringSlice) Value() (driver.Value, error) {
	if s == nil {
		return "[]", nil
	}
	b, err := json.Marshal(s)
	return string(b), err
}

func (s *StringSlice) Scan(v interface{}) error {
	if v == nil {
		*s = nil
		return nil
	}
	var str string
	switch t := v.(type) {
	case string:
		str = t
	case []byte:
		str = string(t)
	default:
		return errors.New("model: unsupported type for StringSlice")
	}
	if str == "" {
		*s = StringSlice{}
		return nil
	}
	return json.Unmarshal([]byte(str), s)
}

// IntSlice 同上，用于 spark 等数值数组
type IntSlice []int

func (s IntSlice) Value() (driver.Value, error) {
	if s == nil {
		return "[]", nil
	}
	b, err := json.Marshal(s)
	return string(b), err
}

func (s *IntSlice) Scan(v interface{}) error {
	if v == nil {
		*s = nil
		return nil
	}
	var str string
	switch t := v.(type) {
	case string:
		str = t
	case []byte:
		str = string(t)
	default:
		return errors.New("model: unsupported type for IntSlice")
	}
	if str == "" {
		*s = IntSlice{}
		return nil
	}
	return json.Unmarshal([]byte(str), s)
}

// Stage 流水线阶段（节点）。Enabled 缺省为 true（=执行该阶段）；
// Kind 是节点类型（git/build/test/image/deploy/notify/wait/custom/backend/frontend），缺省为 custom。
// ParallelOf 表示该节点是哪个主线 stage 的并行任务（值为父 stage Name），空=主线。
// Config 是 kind 相关的配置（JSON 文本，如 git 仓库 URL、分支；image 镜像；deploy 命名空间/工作负载等）。
type Stage struct {
	Name       string `json:"name"`
	Status     string `json:"status,omitempty"`
	Enabled    *bool  `json:"enabled,omitempty"`
	Kind       string `json:"kind,omitempty"`
	Desc       string `json:"desc,omitempty"`
	ParallelOf string `json:"parallelOf,omitempty"`
	Config     string `json:"config,omitempty"`
}

// StageSlice 流水线 stages 数组，序列化为 JSON 文本
type StageSlice []Stage

func (s StageSlice) Value() (driver.Value, error) {
	if s == nil {
		return "[]", nil
	}
	b, err := json.Marshal(s)
	return string(b), err
}

func (s *StageSlice) Scan(v interface{}) error {
	if v == nil {
		*s = nil
		return nil
	}
	var str string
	switch t := v.(type) {
	case string:
		str = t
	case []byte:
		str = string(t)
	default:
		return errors.New("model: unsupported type for StageSlice")
	}
	if str == "" {
		*s = StageSlice{}
		return nil
	}
	return json.Unmarshal([]byte(str), s)
}

// BuildStage 一次构建中各阶段的运行态（带 console 日志与耗时）
type BuildStage struct {
	Name       string `json:"name"`
	Status     string `json:"status"` // pending | running | ok | err | aborted
	Log        string `json:"log"`
	StartedAt  string `json:"startedAt,omitempty"`
	FinishedAt string `json:"finishedAt,omitempty"`
}

// BuildStageSlice 构建阶段运行态数组，序列化为 JSON 文本
type BuildStageSlice []BuildStage

func (s BuildStageSlice) Value() (driver.Value, error) {
	if s == nil {
		return "[]", nil
	}
	b, err := json.Marshal(s)
	return string(b), err
}

func (s *BuildStageSlice) Scan(v interface{}) error {
	if v == nil {
		*s = nil
		return nil
	}
	var str string
	switch t := v.(type) {
	case string:
		str = t
	case []byte:
		str = string(t)
	default:
		return errors.New("model: unsupported type for BuildStageSlice")
	}
	if str == "" {
		*s = BuildStageSlice{}
		return nil
	}
	return json.Unmarshal([]byte(str), s)
}

// BuildSource 序列化与反序列化（独立列、文本 JSON）。
// BuildSource 字段已是 model.BuildSource；这里仅实现 driver.Valuer / Scanner。
func (s BuildSource) Value() (driver.Value, error) {
	if (s == BuildSource{}) {
		return "{}", nil
	}
	b, err := json.Marshal(s)
	if err != nil {
		return nil, err
	}
	return string(b), nil
}

func (s *BuildSource) Scan(v interface{}) error {
	if v == nil {
		*s = BuildSource{}
		return nil
	}
	var str string
	switch t := v.(type) {
	case string:
		str = t
	case []byte:
		str = string(t)
	default:
		return errors.New("model: unsupported type for BuildSource")
	}
	if str == "" {
		*s = BuildSource{}
		return nil
	}
	return json.Unmarshal([]byte(str), s)
}
