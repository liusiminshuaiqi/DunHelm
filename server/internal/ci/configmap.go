package ci

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"
)

// ConfigMapConfig 「配置管理 (Configmap)」节点的配置（stage.Config 反序列化）。
//   - Mode: read  仅读取 ConfigMap 并把 data 列表写入阶段日志（审计场景）；
//           write 读取后用 DataJSON 整体覆盖 data 字段（运维场景：批量改一处配置）。
//   - Namespace / Name: 目标 ConfigMap。
//   - DataJSON: write 模式下使用；read 模式忽略。形如 {"key1":"value1","key2":"value2"}。
type ConfigMapConfig struct {
	Mode      string `json:"mode"`      // read | write
	Namespace string `json:"namespace"`
	Name      string `json:"name"`
	DataJSON  string `json:"data_json"` // write 模式使用
}

// ConfigMapResult 阶段执行结果（用于 stage 日志里拼接真实集群输出）。
type ConfigMapResult struct {
	LogLines []string
	Mode     string
	NS       string
	Name     string
	// Write 模式下：覆盖后 data 的 key 数量。Read 模式下：读取到 data 的 key 数量。
	KeyCount int
}

// RunConfigMap 解析 configmap 阶段 config，真实打到第一个已注册集群。
//   - read：GetConfigMap → 列出所有 data key→value 到日志
//   - write：解析 DataJSON（map[string]string）→ UpsertConfigMap 整体覆盖
func (e *Engine) RunConfigMap(stageConfig string) (*ConfigMapResult, error) {
	res := &ConfigMapResult{}
	cfg, perr := parseConfigMapConfig(stageConfig)
	if perr != nil {
		return res, fmt.Errorf("configmap 配置解析失败: %w", perr)
	}
	cfg.Mode = strings.ToLower(strings.TrimSpace(cfg.Mode))
	if cfg.Mode == "" {
		cfg.Mode = "read"
	}
	if cfg.Mode != "read" && cfg.Mode != "write" {
		return res, fmt.Errorf("configmap mode 必须是 read 或 write，当前: %q", cfg.Mode)
	}
	if strings.TrimSpace(cfg.Namespace) == "" {
		return res, fmt.Errorf("namespace 必填")
	}
	if strings.TrimSpace(cfg.Name) == "" {
		return res, fmt.Errorf("name 必填")
	}
	res.Mode = cfg.Mode
	res.NS = cfg.Namespace
	res.Name = cfg.Name

	// 选集群：取第一个已注册且有 KubeConfig 的集群（与 deploy 节点保持一致）
	cid, chosenName, cerr := e.pickCluster()
	if cerr != nil {
		return res, cerr
	}

	res.LogLines = append(res.LogLines, fmt.Sprintf("$ target cluster = #%d (%s)", cid, chosenName))
	res.LogLines = append(res.LogLines, fmt.Sprintf("$ mode = %s", cfg.Mode))

	if cfg.Mode == "read" {
		view, gerr := e.k8s.GetConfigMap(cid, cfg.Namespace, cfg.Name)
		if gerr != nil {
			return res, fmt.Errorf("读取 ConfigMap 失败: %w", gerr)
		}
		res.LogLines = append(res.LogLines,
			fmt.Sprintf("$ kubectl get configmap %s -n %s -o jsonpath='{.data}'", cfg.Name, cfg.Namespace),
			fmt.Sprintf("name:      %s", view.Name),
			fmt.Sprintf("namespace: %s", view.Namespace),
		)
		if len(view.Labels) > 0 {
			res.LogLines = append(res.LogLines, fmt.Sprintf("labels:    %s", formatKV(view.Labels)))
		}
		if len(view.Annotations) > 0 {
			res.LogLines = append(res.LogLines, fmt.Sprintf("annotations: %s", formatKV(view.Annotations)))
		}
		// data 列出
		res.KeyCount = len(view.Data)
		if len(view.Data) == 0 {
			res.LogLines = append(res.LogLines, "data:      (空)")
			if len(view.BinaryData) > 0 {
				res.LogLines = append(res.LogLines, fmt.Sprintf("binaryData: %d 项（二进制，未在日志中展开）", len(view.BinaryData)))
			}
			return res, nil
		}
		res.LogLines = append(res.LogLines, fmt.Sprintf("data:      %d 项", len(view.Data)))
		// 稳定排序后逐项展开
		keys := make([]string, 0, len(view.Data))
		for k := range view.Data {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			v := view.Data[k]
			// 较长值截断显示，避免日志被超长配置淹没
			display := v
			if len(display) > 400 {
				display = display[:400] + "...(已截断，原始长度 " + fmt.Sprintf("%d", len(v)) + " 字节)"
			}
			res.LogLines = append(res.LogLines, fmt.Sprintf("  %s: %s", k, display))
		}
		if len(view.BinaryData) > 0 {
			res.LogLines = append(res.LogLines, fmt.Sprintf("binaryData: %d 项（二进制，未在日志中展开）", len(view.BinaryData)))
		}
		return res, nil
	}

	// write 模式
	var data map[string]string
	if err := json.Unmarshal([]byte(cfg.DataJSON), &data); err != nil {
		return res, fmt.Errorf("data_json 解析失败（必须是 JSON 对象 {key:value}）: %w", err)
	}
	if data == nil {
		data = map[string]string{}
	}
	view, uerr := e.k8s.UpsertConfigMap(cid, cfg.Namespace, cfg.Name, data, nil, nil)
	if uerr != nil {
		return res, fmt.Errorf("写入 ConfigMap 失败: %w", uerr)
	}
	res.LogLines = append(res.LogLines,
		fmt.Sprintf("$ kubectl apply -f <configmap-%s.yaml> -n %s", cfg.Name, cfg.Namespace),
		fmt.Sprintf("configmap/%s configured (data %d 项)", view.Name, len(view.Data)),
	)
	res.KeyCount = len(view.Data)
	return res, nil
}

// pickCluster 选择第一个已注册且有 KubeConfig 的集群（与 deploy 节点逻辑保持一致）。
func (e *Engine) pickCluster() (uint, string, error) {
	clusters, err := e.store.Clusters()
	if err != nil || len(clusters) == 0 {
		return 0, "", fmt.Errorf("未找到已注册集群：请先在「集群」页登记 KubeConfig")
	}
	for _, cl := range clusters {
		if cl.KubeConfig != "" {
			return cl.ID, cl.Name, nil
		}
	}
	return 0, "", fmt.Errorf("所有已注册集群都未配置 KubeConfig：请先在「集群」页粘贴 KubeConfig")
}

// parseConfigMapConfig 解析 stage.Config JSON；空串返空 struct（将走兜底校验）。
func parseConfigMapConfig(s string) (ConfigMapConfig, error) {
	var c ConfigMapConfig
	if strings.TrimSpace(s) == "" {
		return c, nil
	}
	if err := json.Unmarshal([]byte(s), &c); err != nil {
		return c, err
	}
	return c, nil
}

// formatKV 把 map[string]string 拼成 "k1=v1, k2=v2" 字符串（日志展示用）。
func formatKV(m map[string]string) string {
	if len(m) == 0 {
		return ""
	}
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf("%s=%s", k, m[k]))
	}
	return strings.Join(parts, ", ")
}