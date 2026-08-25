package ci

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"kubehelm/server/internal/k8s"
	"kubehelm/server/internal/model"
	"kubehelm/server/internal/repository"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
)

// Engine 自研轻量 CI 引擎（参考 Jenkins：Pipeline=Job，Build=运行，Stage=阶段，Log=控制台输出）。
// 默认按阶段顺序推进、写入合成 console 日志与耗时，支持运行中中止。
// 真实 deploy 阶段会调用 k8s.CreateWorkload 把工作负载发布到集群，其余阶段保持模拟日志。
// 支持四种触发模式：git（拉取仓库）/ backend（上传后端编译包）/ frontend（上传前端静态包）/ image（直接发布镜像）。
type Engine struct {
	store   *repository.Store
	k8s     *k8s.Manager
	mu      sync.Mutex
	cancels map[uint]context.CancelFunc
	// pods 记录每个运行中的构建对应的临时构建 Pod 名（dun-build-xxxx），
	// 用于中止时直接删除 Pod 来真正打断正在 Pod 内运行的 kubectl exec 长命令。
	pods map[uint]string
}

func New(store *repository.Store, k *k8s.Manager) *Engine {
	return &Engine{store: store, k8s: k, cancels: make(map[uint]context.CancelFunc), pods: make(map[uint]string)}
}

// Run 触发一次构建：source 描述触发模式与具体来源；pipelineName 仅做查表用。
// 返回构建编号 (BuildNo)。
func (e *Engine) Run(pipelineName string, source model.BuildSource, cid uint) (string, error) {
	p, err := e.store.PipelineByName(pipelineName, cid)
	if err != nil {
		return "", fmt.Errorf("流水线不存在: %s", pipelineName)
	}
	// 填充默认分支（git 模式）
	if source.Branch == "" {
		source.Branch = p.Branch
	}
	if source.TriggerMode == "" {
		source.TriggerMode = p.TriggerMode
		if source.TriggerMode == "" {
			source.TriggerMode = "git"
		}
	}
	if source.Repo == "" {
		source.Repo = p.Repo
	}
	if source.Image == "" {
		source.Image = p.DefaultImage
	}
	if source.Namespace == "" {
		source.Namespace = p.TargetNamespace
	}
	if source.Workload == "" {
		source.Workload = p.TargetWorkload
	}

	// 阶段定义：按 enabled 过滤（关闭的阶段标 skipped）
	stages := make(model.BuildStageSlice, 0, len(p.Stages))
	for _, s := range p.Stages {
		if s.Enabled != nil && !*s.Enabled {
			stages = append(stages, model.BuildStage{Name: s.Name, Status: "skipped", Log: fmt.Sprintf("[%s] 已关闭，跳过\n", s.Name)})
			continue
		}
		stages = append(stages, model.BuildStage{Name: s.Name, Status: "pending"})
	}
	no, err := e.store.NextBuildNo()
	if err != nil {
		return "", err
	}
	triggerLabel := triggerLabel(source.TriggerMode)
	b := &model.Build{
		BuildNo:      no,
		PipelineName: pipelineName,
		ClusterID:    cid,
		Status:       "running",
		Branch:       source.Branch,
		Trigger:      triggerLabel,
		Time:         time.Now().Format("15:04"),
		Stages:       stages,
		Source:       source,
	}
	if err := e.store.CreateBuild(b); err != nil {
		return "", err
	}
	_ = e.store.PatchPipeline(pipelineName, cid, map[string]interface{}{
		"last_status": "running",
		"last_run":    b.Time,
	})
	ctx, cancel := context.WithCancel(context.Background())
	e.mu.Lock()
	e.cancels[b.ID] = cancel
	e.mu.Unlock()
	go e.execute(ctx, b.ID)
	return no, nil
}

// Abort 中止正在运行的构建（通过取消 ctx 让执行协程收尾，或直接删 Pod 打断 exec）。
//
// 僵尸保护：若构建在 DB 中仍为 running，但引擎内已无对应存活协程（如进程重启后内存中的
// cancels/pods 映射丢失），则 cancel() 无从生效 —— 此时直接强制把状态标记为 aborted，
// 并尽力清理可能仍在集群里跑着的孤儿 Pod，避免「UI 显示运行中、中止按钮可用、点了却无效」的卡死。
func (e *Engine) Abort(buildNo string) error {
	b, err := e.store.BuildByNo(buildNo)
	if err != nil {
		return err
	}
	if b.Status != "running" {
		return fmt.Errorf("构建 %s 非运行中，无法中止", buildNo)
	}
	e.mu.Lock()
	cancel, ok := e.cancels[b.ID]
	podName := e.pods[b.ID]
	e.mu.Unlock()
	if ok {
		// 1) 取消 ctx：让阶段边界处的 ctx.Done() 检查、mock 路径的 select、以及
		//    deploy 阶段的循环能尽快收尾。
		cancel()
	}
	// 2) 关键：真正打断正在 Pod 内运行的 kubectl exec（mvn / docker build 等长命令）。
	//    仅 cancel() ctx 不足以让 remotecommand.StreamWithContext 立即从阻塞读中返回，
	//    构建会一直跑到该阶段命令自然结束（或 30min 超时）才停。直接删 Pod 让容器内进程被杀、
	//    exec stream 立刻断开，execute 协程随即从阻塞中返回并标记 aborted。
	if podName != "" {
		if p, perr := e.store.PipelineByName(b.PipelineName, b.ClusterID); perr == nil {
			hint := strings.TrimSpace(p.Cluster)
			if cs, _, kerr := e.acquireKubeClientWithCtx(context.Background(), hint); kerr == nil {
				_ = deleteBuildPodResources(context.Background(), cs, podName)
			}
		}
		e.mu.Lock()
		delete(e.pods, b.ID)
		e.mu.Unlock()
	}
	// 3) 僵尸保护：没有存活协程（ok==false）却仍标记 running，说明协程已死（进程重启最常见），
	//    必须主动把状态改掉，否则它会永远卡在 running、UI 中止按钮点了也无效。
	if !ok {
		if podName == "" {
			podName = extractBuildPodName(b)
		}
		if podName != "" {
			if p, perr := e.store.PipelineByName(b.PipelineName, b.ClusterID); perr == nil {
				hint := strings.TrimSpace(p.Cluster)
				if cs, _, kerr := e.acquireKubeClientWithCtx(context.Background(), hint); kerr == nil {
					_ = deleteBuildPodResources(context.Background(), cs, podName)
				}
			}
		}
		e.markAborted(b, podName)
	}
	return nil
}

// Recover 引擎启动时调用：扫描所有遗留为 running 的构建（进程重启后不再有存活协程可继续），
// 强制标记为 aborted 并清理其可能残留的临时构建 Pod。这样可彻底避免「僵尸构建」——
// 即 DB 状态卡在 running、UI 中止按钮可用但点了却无法真正中止、状态也永不改变。
//
// 已在本进程内有存活协程的构建（hasLive）不会被误标，交给协程自身正常结束。
func (e *Engine) Recover() {
	list, err := e.store.Builds("", 0)
	if err != nil {
		return
	}
	e.mu.Lock()
	live := make(map[uint]bool, len(e.cancels))
	for id := range e.cancels {
		live[id] = true
	}
	e.mu.Unlock()
	for i := range list {
		if list[i].Status != "running" {
			continue
		}
		b := list[i]
		if live[b.ID] {
			continue
		}
		podName := extractBuildPodName(&b)
		if podName != "" {
			if p, perr := e.store.PipelineByName(b.PipelineName, b.ClusterID); perr == nil {
				hint := strings.TrimSpace(p.Cluster)
				if cs, _, kerr := e.acquireKubeClientWithCtx(context.Background(), hint); kerr == nil {
					_ = deleteBuildPodResources(context.Background(), cs, podName)
				}
			}
		}
		e.markAborted(&b, podName)
	}
}

// extractBuildPodName 从构建各阶段日志里提取临时构建 Pod 名（dun-build-<4hex>）。
// 进程重启后 e.pods 映射丢失，但日志里仍记录着「kubectl run dun-build-XXXX」启动命令，
// 可用于兜底清理残留的孤儿 Pod（否则它会一直在集群里跑 npm install 等）。
func extractBuildPodName(b *model.Build) string {
	re := regexp.MustCompile(`dun-build-[0-9a-f]{4}`)
	for i := range b.Stages {
		if m := re.FindString(b.Stages[i].Log); m != "" {
			return m
		}
	}
	return ""
}

// execute 顺序执行各阶段；任意阶段可被 ctx 取消 → 标记 aborted。
func (e *Engine) execute(ctx context.Context, buildID uint) {
	defer func() {
		e.mu.Lock()
		delete(e.cancels, buildID)
		delete(e.pods, buildID)
		e.mu.Unlock()
	}()

	b, err := e.store.BuildByID(buildID)
	if err != nil {
		return
	}
	// 拉取流水线定义以拿到每个 stage 的 kind + config（BuildStage 不含这两个字段）
	p, perr := e.store.PipelineByName(b.PipelineName, b.ClusterID)
	if perr != nil {
		return
	}
	stageMetaByName := make(map[string]model.Stage, len(p.Stages))
	for _, s := range p.Stages {
		stageMetaByName[s.Name] = s
	}
	start := time.Now()
	// currentImage 跟踪「当前应发布的镜像」：初始为触发源镜像，遇到 image / push 节点会被覆盖，
	// 最终作为 deploy 阶段的兜底镜像（deploy 节点自身未显式填镜像时复用）。
	currentImage := b.Source.Image

	// cloneDir：git 克隆阶段完成后记录仓库目录名（如 sinopec-charging-ext），
	// 后续非 git 阶段的真实 exec 命令会自动 cd 进该目录执行，
	// 避免命令落在临时构建 Pod 默认工作目录 /root 下而找不到工程文件（之前 mvn 报 "no POM" 就源于此）。
	cloneDir := ""

	// —— 临时构建 Pod 模型 ——
	// 优先尝试在真实集群上拉起 Pod（dun-build-<4hex>），后续 exec 真实执行用户命令；
	// 失败时（无可用集群 / 拉镜像失败 / Pod 起不来）自动回退到合成 mock 日志，
	// 保证画布体验不退化。
	//
	// acquireKubeClient 包在 30s 超时 ctx 里：防止 client-go 拨号挂死导致整个 build 流程
	// 永远卡在 pending（之前 #2854 就是这种情况）。
	podImage := e.resolveBuildPodImage(p, b.Source)
	podName := ""
	var podStart []string
	var podStartWarn string
	realExec := false
	mavenGlobalMounted := false
	// 镜像仓库自动登录凭据：host → RegistryCred（明文密码）。无论 Pod 是否成功起，都提前解析好，
	// 这样即便 fallback 到 mock 日志路径，dockerBuildSteps / pushSteps 仍能生成正确的 login 步骤。
	registryCreds := e.resolveRegistryCreds(p)
	var execCS kubernetes.Interface
	var execRest *rest.Config
	if podImage != "" {
		// 构建集群统一在流水线基础信息配置（p.Cluster，clusterID 字符串）；留空则用首个 Connected 集群。
		hint := strings.TrimSpace(p.Cluster)
		acqCtx, acqCancel := context.WithTimeout(ctx, 30*time.Second)
		cs, rc, kerr := e.acquireKubeClientWithCtx(acqCtx, hint)
		acqCancel()
		if kerr == nil {
			podName = "dun-build-" + randHex(4)
			// 确保 dunhelm-ci 命名空间存在，便于先把 maven 全局 ConfigMap / 流水级 Secret 建好
			// （Pod 挂载引用它们，必须在 Pod 创建前存在，否则 Pod 会卡 Pending）。
			if nsErr := ensureNamespace(ctx, cs); nsErr != nil {
				podStartWarn += fmt.Sprintf("[警告] 确认构建命名空间失败: %v\n", nsErr)
			}
			// —— Maven settings 双层挂载准备 ——
			// 1) 平台级 global（mirror/proxy，无密钥）→ 固定 ConfigMap，所有构建 Pod 共享挂载；
			// 2) 流水级 user（servers/凭证，敏感）→ 本次构建专用 Secret，挂 /root/.m2/settings.xml。
			globalMaven, userMaven := "", ""
			if m, gerr := e.store.GetMavenGlobalSettings(b.ClusterID); gerr == nil && strings.TrimSpace(m.Content) != "" {
				globalMaven = m.Content
				if uerr := upsertMavenGlobalConfigMap(ctx, cs, globalMaven); uerr != nil {
					globalMaven = "" // 降级：构建不带全局 mirror/proxy，不阻断
					podStartWarn += fmt.Sprintf("[警告] 写入 maven 全局配置失败: %v（构建将不带全局 mirror/proxy）\n", uerr)
				}
			}
		if um := strings.TrimSpace(p.MavenSettings); um != "" {
			if _, suerr := createMavenSettingsSecret(ctx, cs, podName, um); suerr != nil {
				podStartWarn += fmt.Sprintf("[警告] 写入 maven 凭证 Secret 失败: %v\n", suerr)
			} else {
				userMaven = um
			}
		}
		mavenGlobalMounted = globalMaven != ""
		if cerr := createBuildPod(ctx, cs, podName, podImage, b.ID, buildPodOptions{
			GlobalMavenSettings: globalMaven,
			UserMavenSettings:   userMaven,
			RegistryEnv:         buildPodRegistryEnv(registryCreds),
			BuilderType:         p.BuilderType,
		}); cerr == nil {
				// 记录 Pod 名，供 Abort 时直接删除以打断在跑的命令
				e.mu.Lock()
				e.pods[b.ID] = podName
				e.mu.Unlock()
				if werr := waitPodReady(ctx, cs, podName); werr == nil {
					realExec = true
					execCS = cs
					execRest = rc
					podStart = []string{
						fmt.Sprintf("$ kubectl run %s --image=%s --restart=Never", podName, podImage),
						fmt.Sprintf("pod/%s created", podName),
						fmt.Sprintf("waiting for pod %s to be running ...", podName),
						fmt.Sprintf("pod %s is running ✓ （构建环境就绪，后续节点操作均在该 Pod 内执行）", podName),
					}
				} else {
					_ = deleteBuildPodResources(context.Background(), cs, podName)
					podName = ""
					podStartWarn = fmt.Sprintf("[警告] 等待 Pod Ready 失败: %v（已 fallback 到 mock 日志）\n", werr)
				}
			} else {
				_ = deleteBuildPodResources(context.Background(), cs, podName)
				podName = ""
				podStartWarn = fmt.Sprintf("[警告] 创建 Pod 失败: %v（已 fallback 到 mock 日志）\n", cerr)
			}
		} else {
			podStartWarn = fmt.Sprintf("[提示] 没有可用构建集群: %v\n         （CI 阶段将以合成 mock 日志形式展示，便于画布与流程调试）\n", kerr)
		}
	}

	firstExecuted := false
	lastStageIdx := -1
	for i := range b.Stages {
		if ctx.Err() != nil {
			e.finishAborted(b, podName, execCS)
			return
		}
		stage := &b.Stages[i]
		if stage.Status == "skipped" {
			// 关闭的阶段：原样写回（log 已生成）
			e.save(b)
			continue
		}
		stage.Status = "running"
		stage.StartedAt = time.Now().Format("15:04:05")
		stage.Log = fmt.Sprintf("[%s] 开始执行 …\n", stage.Name)
		// 首个执行的阶段：前置"启动临时构建 Pod"日志（真起 Pod 时打印 podStart，失败时打印 podStartWarn 提示）
		if !firstExecuted {
			if len(podStart) > 0 {
				stage.Log += strings.Join(podStart, "\n") + "\n"
			}
			if podStartWarn != "" {
				stage.Log += podStartWarn
			}
			firstExecuted = true
		}
		e.save(b)
		lastStageIdx = i

		meta := stageMetaByName[stage.Name]
		// 按节点 kind 生成阶段日志：deploy 走真实 K8s 下发，git/build/image/push 走模拟日志（与配置强相关）。
		var lines []string
		// realOverride：仅当某 kind 自己接管"真实 exec 命令"时填入（如 git 阶段用真密码 + url 编码后的 URL），
		// 让下方真 exec 分支跳过从 lines 里提取 "$ " 行的统一逻辑。
		var realOverride []string
		switch meta.Kind {
		case "deploy":
			res, derr := e.RunDeploy(meta.Config, currentImage)
			if derr != nil {
				stage.Status = "err"
				stage.FinishedAt = time.Now().Format("15:04:05")
				stage.Log += fmt.Sprintf("[err] %v\n", derr)
				e.save(b)
				b.Status = "err"
				b.Duration = fmtDuration(time.Since(start))
				e.save(b)
				_ = e.store.PatchPipeline(b.PipelineName, b.ClusterID, map[string]interface{}{
					"last_status": "err",
					"last_run":    b.Time,
					"duration":    b.Duration,
				})
				return
			}
			for _, ln := range res.LogLines {
				if ctx.Err() != nil {
					e.finishAborted(b, podName, execCS)
					return
				}
				stage.Log += ln + "\n"
				e.save(b)
				time.Sleep(simStepDelay)
			}
		case "configmap":
			// 配置管理：read 模式把 data 写到日志；write 模式覆盖 data 到集群。
			res, cerr := e.RunConfigMap(meta.Config)
			if cerr != nil {
				stage.Status = "err"
				stage.FinishedAt = time.Now().Format("15:04:05")
				stage.Log += fmt.Sprintf("[err] %v\n", cerr)
				e.save(b)
				b.Status = "err"
				b.Duration = fmtDuration(time.Since(start))
				e.save(b)
				_ = e.store.PatchPipeline(b.PipelineName, b.ClusterID, map[string]interface{}{
					"last_status": "err",
					"last_run":    b.Time,
					"duration":    b.Duration,
				})
				return
			}
			for _, ln := range res.LogLines {
				if ctx.Err() != nil {
					e.finishAborted(b, podName, execCS)
					return
				}
				stage.Log += ln + "\n"
				e.save(b)
				time.Sleep(simStepDelay)
			}
		case "git":
			gitDisp, gitExec := e.gitSteps(meta.Config, b.Source)
			lines = gitDisp
			// 记录克隆目录名，供后续阶段自动 cd（git clone 不指定目录时默认克隆到 Pod /root 下的仓库名目录）
			if repo := stageConfigString(meta.Config, "repo"); repo != "" {
				cloneDir = repoName(repo)
			} else {
				cloneDir = repoName(b.Source.Repo)
			}
			// git 真 exec 不沿用 lines 里的 "$ " 行（那里 URL 密码是 ***），改走 gitExec
			// （含真密码 + net/url 编码后的 URL）。
			if realExec && podName != "" && len(gitExec) > 0 {
				realOverride = gitExec
			}
		case "build":
			lines = e.buildSteps(meta.Config, b.Source)
		case "image":
			img := stageConfigString(meta.Config, "image")
			if img != "" {
				currentImage = img
			}
			lines = e.imageRefSteps(img, b.ClusterID)
		case "docker-build":
			ref, dbLines := e.dockerBuildSteps(meta.Config, b.PipelineName, p.Runtime, registryCreds, b.ClusterID)
			currentImage = ref
			lines = dbLines
		case "push":
			ref, plines := e.pushSteps(meta.Config, b.PipelineName, currentImage, p.Runtime, registryCreds, b.ClusterID)
			currentImage = ref
			lines = plines
		default:
			lines = e.stageSteps(stage.Name, b.Source)
		}
		if meta.Kind != "deploy" && meta.Kind != "configmap" {
			if realExec && podName != "" {
				// —— 真 exec 路径 ——
				// 把阶段所有 "$ cmd" 行（kubectl exec 包装前）合并为单条 shell 命令，在临时 Pod 内真跑；
				// 其他行（说明 / 状态）原样写入日志。stdout/stderr 通过 stream 回调实时回写到 stage.Log，
				// 配合前端轮询可看到 mvn/npm/go build 的真实输出流。
				// 特殊情况：git 阶段会把真密码填进 URL，由 realOverride 接管，避免和展示版（***）混用。
				var cmdLines []string
				if len(realOverride) > 0 {
					cmdLines = realOverride
				} else {
					for _, ln := range lines {
						if strings.HasPrefix(ln, "$ ") {
							cmdLines = append(cmdLines, ln[2:])
						} else {
							stage.Log += ln + "\n"
							e.save(b)
						}
					}
				}
				if len(cmdLines) > 0 {
					// git 克隆后，非 git 阶段的命令自动 cd 进仓库目录执行（临时构建 Pod 工作目录默认 /root）。
					if cloneDir != "" && meta.Kind != "git" {
						cmdLines = append([]string{"cd " + cloneDir}, cmdLines...)
					}
					fullCmd := strings.Join(cmdLines, "\n")
					// 平台级 maven global settings 已挂到固定路径：命令含 mvn 时注入 -gs 让其读取
					// （各 maven 镜像 MAVEN_HOME 不一致，无法直接覆盖 conf/settings.xml）。
					if mavenGlobalMounted {
						fullCmd = injectMavenGlobalSettingsFlag(fullCmd)
					}
					// 打印将要执行的命令（kubectl exec 形式）；url-style 密码落到日志前先脱敏
					// （git 阶段真密码在 URL 里；其它阶段用户自定义命令可能也含密码，做脱敏对调试无影响）。
					displayCmd := maskCommandPasswords(fullCmd)
					stage.Log += fmt.Sprintf("$ kubectl exec %s -- sh -c %s\n", podName, shellQuote(displayCmd))
					e.save(b)
					// 单条命令 30min 超时（编译 maven 大项目可能很慢）
					execCtx, cancel := context.WithTimeout(ctx, 30*time.Minute)
					res, eerr := execInPod(execCtx, execCS, execRest, podName, fullCmd, func(stream, line string) {
						if stream == "err" {
							stage.Log += line + "\n"
						} else {
							stage.Log += line + "\n"
						}
						e.save(b)
					})
				cancel()
				if ctx.Err() != nil {
					// 构建被用户中止（Pod 已删除，exec stream 断开）：标记 aborted 而非 err
					e.finishAborted(b, podName, execCS)
					return
				}
				if eerr != nil {
					stage.Status = "err"
					stage.Log += fmt.Sprintf("[err] kubectl exec 失败: %v\n", eerr)
					e.save(b)
					b.Status = "err"
					b.Duration = fmtDuration(time.Since(start))
					e.save(b)
					_ = e.store.PatchPipeline(b.PipelineName, b.ClusterID, map[string]interface{}{
						"last_status": "err", "last_run": b.Time, "duration": b.Duration,
					})
					// 真 exec 失败也要清理 Pod + maven Secret
					_ = deleteBuildPodResources(context.Background(), execCS, podName)
					return
				}
				if res.ExitCode != 0 {
					if ctx.Err() != nil {
						e.finishAborted(b, podName, execCS)
						return
					}
					stage.Status = "err"
					stage.Log += fmt.Sprintf("[err] 命令退出码 %d\n", res.ExitCode)
					e.save(b)
					b.Status = "err"
					b.Duration = fmtDuration(time.Since(start))
					e.save(b)
					_ = e.store.PatchPipeline(b.PipelineName, b.ClusterID, map[string]interface{}{
						"last_status": "err", "last_run": b.Time, "duration": b.Duration,
					})
					_ = deleteBuildPodResources(context.Background(), execCS, podName)
					return
				}
				}
			} else {
				// —— 原 mock 路径（无真实构建集群 / 阶段非 deploy）——
				lines = e.wrapStageLines(lines, podName)
				for _, ln := range lines {
					select {
					case <-ctx.Done():
						e.finishAborted(b, podName, execCS)
						return
					case <-time.After(simStepDelay):
						stage.Log += ln + "\n"
						e.save(b)
					}
				}
			}
		}
		stage.Status = "ok"
		stage.FinishedAt = time.Now().Format("15:04:05")
		stage.Log += fmt.Sprintf("[%s] 完成 ✓\n", stage.Name)
		e.save(b)
	}

	// 构建完成：回收临时构建 Pod（追加到最后一个执行的阶段日志）
	if podName != "" && lastStageIdx >= 0 {
		b.Stages[lastStageIdx].Log += fmt.Sprintf("$ kubectl delete pod %s\n", podName)
		b.Stages[lastStageIdx].Log += fmt.Sprintf("pod %s deleted ✓ （临时构建环境已回收）\n", podName)
		e.save(b)
	}
	if realExec && podName != "" && execCS != nil {
		_ = deleteBuildPodResources(context.Background(), execCS, podName)
	}

	b.Status = "ok"
	b.Duration = fmtDuration(time.Since(start))
	e.save(b)
	_ = e.store.PatchPipeline(b.PipelineName, b.ClusterID, map[string]interface{}{
		"last_status": "ok",
		"last_run":    b.Time,
		"duration":    b.Duration,
	})
}

func (e *Engine) finishAborted(b *model.Build, podName string, execCS kubernetes.Interface) {
	// 真正回收临时构建 Pod + maven Secret：之前只写删除日志不实际删除，会残留孤儿 Pod。
	if podName != "" && execCS != nil {
		_ = deleteBuildPodResources(context.Background(), execCS, podName)
	}
	e.markAborted(b, podName)
}

// markAborted 把构建标记为 aborted：更新构建与各阶段状态、补写中止日志、回收 DB 状态。
// 抽出来供 finishAborted（正常中止路径）与 Recover / Abort 僵尸保护（无存活协程时）共用。
func (e *Engine) markAborted(b *model.Build, podName string) {
	b.Status = "aborted"
	now := time.Now().Format("15:04:05")
	for i := range b.Stages {
		if b.Stages[i].Status == "running" {
			if podName != "" {
				b.Stages[i].Log += fmt.Sprintf("\n$ kubectl delete pod %s --wait=false\n", podName)
				b.Stages[i].Log += fmt.Sprintf("pod %s terminated ✓ （构建已中止，临时构建环境回收）\n", podName)
			}
			b.Stages[i].Status = "aborted"
			b.Stages[i].FinishedAt = now
			b.Stages[i].Log += "\n[aborted] 构建已中止\n"
		}
	}
	e.save(b)
	_ = e.store.PatchPipeline(b.PipelineName, b.ClusterID, map[string]interface{}{
		"last_status": "aborted",
		"last_run":    b.Time,
	})
}

func (e *Engine) save(b *model.Build) {
	_ = e.store.UpdateBuild(b)
	// 构建进入终态（ok/err/aborted）后，按平台保留条数清理该流水线旧记录
	if b.Status == "ok" || b.Status == "err" || b.Status == "aborted" {
		if keep, gerr := e.store.GetBuildRetention(); gerr == nil {
			_ = e.store.PurgeOldBuilds(b.PipelineName, keep, b.ClusterID)
		}
	}
}

// simStepDelay 每个合成日志行的间隔（控制单次构建总时长）。
const simStepDelay = 350 * time.Millisecond

// triggerLabel 触发模式的中文标签
func triggerLabel(mode string) string {
	switch mode {
	case "git":
		return "push"
	case "backend":
		return "package:backend"
	case "frontend":
		return "package:frontend"
	case "image":
		return "image"
	default:
		return mode
	}
}

// stageSteps 按阶段名 + 触发模式生成合成控制台日志行。
// 同一阶段在不同模式下行为不同（如 Image 模式：Build 阶段跳过编译，直接校验镜像可拉取）。
func (e *Engine) stageSteps(name string, src model.BuildSource) []string {
	mode := src.TriggerMode
	// 镜像模式：Build/Test 直接走镜像逻辑
	if mode == "image" && (containsAny(strings.ToLower(name), []string{"build", "编译", "构建"}) ||
		containsAny(strings.ToLower(name), []string{"test", "测试"})) {
		return imageStageSteps(name, src.Image)
	}
	// 后端包模式：Clone/Build/Test 走包路径
	if mode == "backend" {
		switch {
		case containsAny(strings.ToLower(name), []string{"clone", "拉取", "checkout"}):
			return []string{
				"$ mode = backend（上传后端编译包，跳过 Clone）",
				fmt.Sprintf("using artifact: %s", src.ArtifactPath),
				fmt.Sprintf("sha256: 9c2f... size: %d KiB", fileSize(src.ArtifactPath)/1024),
				"verified signature ✓",
			}
		case containsAny(strings.ToLower(name), []string{"build", "编译", "构建"}):
			return []string{
				"$ tar -xzf " + src.ArtifactPath + " -C /workspace",
				"x bin/server",
				"x bin/server.sock",
				"x manifests/",
				"extracted " + fmt.Sprint(fileSize(src.ArtifactPath)/1024) + " KiB ✓",
			}
		case containsAny(strings.ToLower(name), []string{"test", "测试"}):
			return []string{
				"$ ./bin/server --smoke-test",
				"starting smoke check ...",
				"listening on :8080",
				"PASS — 12 / 12 checks",
			}
		}
	}
	// 前端包模式：Clone/Build/Test 走静态包路径
	if mode == "frontend" {
		switch {
		case containsAny(strings.ToLower(name), []string{"clone", "拉取", "checkout"}):
			return []string{
				"$ mode = frontend（上传前端静态包，跳过 Clone）",
				fmt.Sprintf("using artifact: %s", src.FrontendPath),
				"verified checksums ✓",
			}
		case containsAny(strings.ToLower(name), []string{"build", "编译", "构建"}):
			return []string{
				"$ unzip -q " + src.FrontendPath + " -d /workspace/dist",
				"x index.html",
				"x assets/index-3a91.js",
				"x assets/index-3a91.css",
				"static assets ready ✓",
			}
		case containsAny(strings.ToLower(name), []string{"test", "测试"}):
			return []string{
				"$ smoke-test static assets",
				"HTML valid",
				"JS bundle size = 412 KiB",
				"PASS",
			}
		}
	}
	// git 模式（或 fallback）：按阶段关键字匹配
	switch {
	case containsAny(strings.ToLower(name), []string{"clone", "拉取", "checkout"}):
		return []string{
			"$ git clone --depth 1 --branch " + src.Branch + " " + repoURL(src.Repo),
			"Cloning into '" + repoName(src.Repo) + "'...",
			"remote: Enumerating objects: 1284, done.",
			"remote: Total 1284 (delta 0), reused 1284 (delta 0)",
			"HEAD is now at a1b2c3d chore: bump version",
		}
	case containsAny(strings.ToLower(name), []string{"build", "编译", "构建"}):
		return []string{
			"$ docker build -t " + repoName(src.Repo) + ":build .",
			"Step 1/6 : FROM golang:1.22-alpine",
			"Step 3/6 : RUN go build -o /app/bin ./cmd/server",
			"go: downloading modules ...",
			"---> Using cache",
			"Successfully built 7f3e9c1a2b4d",
		}
	case containsAny(strings.ToLower(name), []string{"test", "测试"}):
		return []string{
			"$ go test ./... -race -cover",
			"ok  	kubehelm/server	(coverage: 78.4%)",
			"ok  	kubehelm/server/internal/ci",
			"--- FAILures: 0",
			"PASS",
		}
	case containsAny(strings.ToLower(name), []string{"image", "镜像", "push"}):
		if mode == "image" {
			return imageStageSteps(name, src.Image)
		}
		return []string{
			"$ docker push " + repoName(src.Repo) + ":build",
			"The push refers to repository [" + repoName(src.Repo) + "]",
			"build: digest: sha256:9c2f... size: 12.4MB",
			"latest: digest: sha256:1a4b... size: 12.4MB",
			"Pushed in 3.2s",
		}
	case containsAny(strings.ToLower(name), []string{"deploy", "部署", "发布"}):
		if mode == "image" {
			return []string{
				"$ kubectl set image deploy/" + fallbackName(src.Workload, repoName(src.Repo)) + " " + fallbackName(src.Workload, repoName(src.Repo)) + "=" + src.Image + " -n " + fallbackNs(src.Namespace, "default"),
				"deployment.apps/" + fallbackName(src.Workload, repoName(src.Repo)) + " image updated",
				"Waiting for rollout status ...",
				"deployment \"" + fallbackName(src.Workload, repoName(src.Repo)) + "\" successfully rolled out",
			}
		}
		if mode == "backend" {
			return []string{
				"$ kubectl apply -f /workspace/manifests/ -n " + fallbackNs(src.Namespace, "default"),
				"deployment.apps/" + repoName(src.Repo) + " configured",
				"Waiting for rollout status ...",
				"deployment \"" + repoName(src.Repo) + "\" successfully rolled out",
			}
		}
		if mode == "frontend" {
			return []string{
				"$ rsync -a /workspace/dist/ nginx:/var/www/html/",
				"sent 2.4M bytes  received 412 bytes  1.4M bytes/s",
				"total size is 8.7M  speedup is 3.6",
				"nginx: reloaded config ✓",
			}
		}
		return []string{
			"$ kubectl apply -f manifests/ -n " + fallbackNs(src.Namespace, "default"),
			"deployment.apps/" + repoName(src.Repo) + " configured",
			"service/" + repoName(src.Repo) + " unchanged",
			"Waiting for rollout status ...",
			"deployment \"" + repoName(src.Repo) + "\" successfully rolled out",
		}
	default:
		return []string{
			"$ run stage: " + name,
			"initializing workspace ...",
			"executing steps ...",
			"stage finished.",
		}
	}
}

// imageStageSteps 镜像模式下 Build/Test/Image 阶段统一走"校验镜像可拉取"
func imageStageSteps(name string, image string) []string {
	img := image
	if img == "" {
		img = "registry.local/default:latest"
	}
	switch {
	case containsAny(strings.ToLower(name), []string{"test", "测试"}):
		return []string{
			fmt.Sprintf("$ docker pull %s", img),
			"Pulling from registry.local",
			"Digest: sha256:9c2f... status: downloaded",
			"$ skopeo inspect --raw " + img + " | jq '.architecture'",
			"amd64 ✓",
		}
	default:
		return []string{
			fmt.Sprintf("$ docker pull %s", img),
			"Digest: sha256:9c2f...",
			fmt.Sprintf("Status: Downloaded newer image for %s", img),
		}
	}
}

func containsAny(s string, subs []string) bool {
	for _, x := range subs {
		if strings.Contains(s, x) {
			return true
		}
	}
	return false
}

// stageConfigString 从 stage.Config（JSON 字符串）中取出指定 key 的字符串值。
// 解析使用 map[string]any（而非 map[string]string）以容忍混类型：
// 同一个 cfg 里若既有 string 字段也有 bool/number 字段（旧数据或前端序列化差异），
// 用 map[string]string 会整张表 unmarshal 失败、返回空——导致后续逻辑拿到"空 host"、
// 镜像仓库自动登录的 host 匹配不到等连锁问题。所有非 string 值通过 fmt.Sprint 转字符串。
func stageConfigString(cfg, key string) string {
	if strings.TrimSpace(cfg) == "" {
		return ""
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(cfg), &m); err != nil {
		return ""
	}
	v, ok := m[key]
	if !ok || v == nil {
		return ""
	}
	switch x := v.(type) {
	case string:
		return strings.TrimSpace(x)
	default:
		return strings.TrimSpace(fmt.Sprint(x))
	}
}

// stageConfigBool 从 stage.Config 解析 bool 值。
// 兼容 ①JSON 真值（true / 1.0）②字符串 "true"/"1"/"yes"/"y"/"on" ③数字 1。
// 同 stageConfigString 用 map[string]any 解析以容忍混类型。
func stageConfigBool(cfg, key string) bool {
	if strings.TrimSpace(cfg) == "" {
		return false
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(cfg), &m); err != nil {
		return false
	}
	v, ok := m[key]
	if !ok || v == nil {
		return false
	}
	switch x := v.(type) {
	case bool:
		return x
	case string:
		s := strings.ToLower(strings.TrimSpace(x))
		return s == "true" || s == "1" || s == "yes" || s == "y" || s == "on"
	case float64:
		return x != 0
	default:
		s := strings.ToLower(strings.TrimSpace(fmt.Sprint(x)))
		return s == "true" || s == "1" || s == "yes" || s == "y" || s == "on"
	}
}

// gitSteps 按鉴权方式生成克隆阶段的内容：
//   - display：写日志 / mock 路径展示用，密码用 *** 遮盖；
//   - execCmds：真实 exec 路径真正送给 kubectl exec 的命令，URL 用 net/url 重新拼装，
//     把 user/password 走 url.UserPassword() 编码，避免含 @ 的用户名被 git/curl 误当 host 分隔符（之前就是因此触发 “Port number ended with '*'”）。
// 凭证模式 (credential) 下还会去集群 K8s Secret 解析出真账号密码嵌入 URL。
func (e *Engine) gitSteps(cfg string, src model.BuildSource) (display []string, execCmds []string) {
	repo := stageConfigString(cfg, "repo")
	if repo == "" {
		repo = src.Repo
	}
	branch := stageConfigString(cfg, "branch")
	if branch == "" {
		branch = src.Branch
	}
	if branch == "" {
		branch = "main"
	}
	authMode := stageConfigString(cfg, "authMode")
	user := stageConfigString(cfg, "username")
	password := stageConfigString(cfg, "password")
	cred := stageConfigString(cfg, "credential")

	dispURL := repoURL(repo)
	execURL := dispURL
	switch authMode {
	case "password":
		if user != "" {
			dispURL = maskURL(repo, user)
		}
		if u, ok := buildGitCloneURL(repoURL(repo), user, password); ok {
			execURL = u
		}
		display = append(display, fmt.Sprintf("$ git clone --depth 1 --branch %s %s", branch, dispURL))
	case "credential":
		display = append(display, fmt.Sprintf("$ using credential: %s", cred))
		display = append(display, fmt.Sprintf("$ git clone --depth 1 --branch %s %s (credential-helper)", branch, dispURL))
		if u, ok := e.resolveCredentialURL(repoURL(repo), cred); ok {
			execURL = u
		}
	default:
		display = append(display, fmt.Sprintf("$ git clone --depth 1 --branch %s %s", branch, dispURL))
	}
	execCmds = append(execCmds, fmt.Sprintf("git clone --depth 1 --branch %s %s", branch, execURL))

	display = append(display,
		fmt.Sprintf("Cloning into '%s'...", repoName(repo)),
		"remote: Enumerating objects: 1284, done.",
		"remote: Total 1284 (delta 0), reused 1284 (delta 0)",
		"HEAD is now at a1b2c3d chore: bump version",
		fmt.Sprintf("checked out branch %s ✓", branch),
	)
	return display, execCmds
}

// buildGitCloneURL 构造带真实账号密码的 git clone URL：用 net/url 把 user/password 走
// url.UserPassword() 编码，自动把 user 里的 '@' 等字符转成 %40，避免 git/curl 把它们当 host 分隔符。
// repo 必须是经 repoURL() 规整过的 https 形式（无 scheme 时也会被补为 https://）。
func buildGitCloneURL(repo, user, password string) (string, bool) {
	if user == "" {
		return "", false
	}
	base := repo
	if !strings.HasPrefix(base, "http://") && !strings.HasPrefix(base, "https://") && !strings.HasPrefix(base, "git@") && !strings.HasPrefix(base, "ssh://") {
		base = "https://" + base
	}
	if strings.HasPrefix(base, "git@") || strings.HasPrefix(base, "ssh://") {
		return base, true
	}
	u, err := url.Parse(base)
	if err != nil || u.Host == "" {
		return "", false
	}
	u.User = url.UserPassword(user, password)
	return u.String(), true
}

// resolveCredentialURL 在 "凭证" 模式下，按已连接集群的 K8s Secret 解析出真实账号密码，
// 拼成可真实 exec 的 git clone URL（解析失败时返回 ok=false，由真实 exec 自然报错）。
func (e *Engine) resolveCredentialURL(repo, credName string) (string, bool) {
	if credName == "" || e.k8s == nil {
		return "", false
	}
	clusters, err := e.store.Clusters()
	if err != nil {
		return "", false
	}
	var cid uint
	found := false
	for i := range clusters {
		if clusters[i].KubeConfig == "" {
			continue
		}
		if _, cerr := e.k8s.Clientset(clusters[i].ID); cerr == nil {
			cid = clusters[i].ID
			found = true
			break
		}
	}
	if !found {
		return "", false
	}
	list, err := e.k8s.Credentials(cid)
	if err != nil {
		return "", false
	}
	var target *model.Credential
	for i := range list {
		if list[i].Name == credName {
			target = &list[i]
			break
		}
	}
	if target == nil {
		return "", false
	}
	data, err := e.k8s.GetSecretData(cid, target.Namespace, target.Name)
	if err != nil {
		return "", false
	}
	user := string(data["username"])
	pass := string(data["password"])
	if pass == "" {
		pass = string(data["token"])
	}
	if pass == "" {
		return "", false
	}
	if user == "" {
		user = "git"
	}
	return buildGitCloneURL(repo, user, pass)
}

// buildSteps 编译阶段仅是"在构建 Pod 中执行构建命令"（命令由用户填写）。
// 临时构建 Pod 的拉起 / 命令的 kubectl exec 包裹由 execute() 统一处理，这里只产出命令本身。
func (e *Engine) buildSteps(cfg string, src model.BuildSource) []string {
	cmd := stageConfigString(cfg, "command")
	if cmd == "" {
		cmd = "npm ci && npm run build"
	}
	return []string{
		"$ " + cmd,
		"---> Running build steps in workspace ...",
		"COPY sources into workspace",
		"RUN " + cmd,
		"build output ready ✓",
	}
}

// resolveBuildPodImage 从源节点（git / 后端包 / 前端包）的 config 读取 baseImage，
// 用于临时启动构建 Pod；image（已有镜像）源节点不承载 baseImage，故不返回。
// 若画布上未配置（兼容旧数据），按触发模式给一个合理默认值。
func (e *Engine) resolveBuildPodImage(p *model.Pipeline, src model.BuildSource) string {
	for _, s := range p.Stages {
		switch s.Kind {
		case "git", "backend", "frontend":
			if img := stageConfigString(s.Config, "baseImage"); img != "" {
				return img
			}
		}
	}
	switch src.TriggerMode {
	case "frontend":
		return "node:20-alpine"
	case "backend":
		return "maven:3.9-eclipse-temurin-17"
	case "git":
		return "golang:1.22-alpine"
	}
	return ""
}

// acquireKubeClient 获取构建集群的 clientset + rest.Config。
// 优先用 hint 指定 clusterID（来自阶段 config.cluster 字段）。
// 否则按 ID 顺序逐个尝试连接 K8s（与 /api/clusters 端点的探测逻辑一致 ——
//   DB 上的 Connected 字段未必反映当前真实可达性，所以这里现场拨号试连），找到首个能成功返回 clientset 的集群。
// 找不到任何可用集群时返回明确错误，构建引擎会 fallback 到合成 mock 日志。
//
// 「拨号成功」判定 = clientset 创建成功 + Discovery.ServerVersion() 在 ctx 超时内返回。
// 这避免 K8s.Clientset() 仅构造 clientset 不拨号带来的"假连通"问题。
// 用 ctx 包裹整个流程；超时时立刻放弃（避免 #2854 类卡死问题）。
func (e *Engine) acquireKubeClient(hint string) (kubernetes.Interface, *rest.Config, error) {
	return e.acquireKubeClientWithCtx(context.Background(), hint)
}

func (e *Engine) acquireKubeClientWithCtx(ctx context.Context, hint string) (kubernetes.Interface, *rest.Config, error) {
	if hint != "" {
		if id, err := strconv.ParseUint(strings.TrimSpace(hint), 10, 64); err == nil && id > 0 {
			if err := ctx.Err(); err != nil {
				return nil, nil, err
			}
			cs, err := e.k8s.Clientset(uint(id))
			if err != nil {
				return nil, nil, err
			}
			if probeCtxErr := probeCluster(ctx, cs); probeCtxErr != nil {
				return nil, nil, fmt.Errorf("集群 #%d 拨号失败: %w", id, probeCtxErr)
			}
			restCfg, err := e.k8s.RestConfig(uint(id))
			if err != nil {
				return nil, nil, err
			}
			return cs, restCfg, nil
		}
	}
	list, err := e.store.Clusters()
	if err != nil {
		return nil, nil, fmt.Errorf("查询集群列表失败: %w", err)
	}
	for _, c := range list {
		if err := ctx.Err(); err != nil {
			return nil, nil, err
		}
		if c.KubeConfig == "" {
			continue
		}
		cs, csErr := e.k8s.Clientset(c.ID)
		if csErr != nil {
			continue
		}
		if probeCtxErr := probeCluster(ctx, cs); probeCtxErr != nil {
			continue
		}
		restCfg, rcErr := e.k8s.RestConfig(c.ID)
		if rcErr != nil {
			continue
		}
		return cs, restCfg, nil
	}
	return nil, nil, fmt.Errorf("未注册任何可用构建集群（请在「集群管理」中配置 kubeconfig 并确认 apiserver 可达）")
}

// probeCluster 真正发一次 apiserver 探测（ServerVersion），排除 Clientset 构造成功但 apiserver 不通的情况。
// client-go 0.36 的 ServerVersion 用的是 context.TODO() 没法直接传 ctx 取消，所以这里用 goroutine +
// 超时 channel 兜底：ctx 超时立刻放弃（之前 #2854 类问题就是 client-go 内部 HTTP 重试挂死）。
func probeCluster(ctx context.Context, cs kubernetes.Interface) error {
	done := make(chan error, 1)
	go func() {
		v, err := cs.Discovery().ServerVersion()
		if err != nil {
			done <- err
			return
		}
		if v == nil || v.GitVersion == "" {
			done <- fmt.Errorf("apiserver 返回空 ServerVersion")
			return
		}
		done <- nil
	}()
	select {
	case <-ctx.Done():
		return fmt.Errorf("探测超时: %w", ctx.Err())
	case err := <-done:
		return err
	}
}

// wrapStageLines 把阶段日志中以 "$ " 开头的 shell 命令行包装成"在临时构建 Pod 内执行"。
// podName 为空时（无临时 Pod，如 image 模式）原样返回。
func (e *Engine) wrapStageLines(lines []string, podName string) []string {
	if podName == "" {
		return lines
	}
	out := make([]string, 0, len(lines))
	for _, ln := range lines {
		if strings.HasPrefix(ln, "$ ") {
			out = append(out, fmt.Sprintf("$ kubectl exec %s -- sh -c %s", podName, shellQuote(ln[2:])))
		} else {
			out = append(out, ln)
		}
	}
	return out
}

// shellQuote 把字符串用单引号包裹，内部单引号正确转义，用于 kubectl exec 的 sh -c 参数。
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// injectMavenGlobalSettingsFlag 当临时构建 Pod 挂了平台级 maven global settings（固定路径，
// 因各 maven 镜像 MAVEN_HOME 不一致无法直接覆盖 conf/settings.xml），且阶段命令含 mvn 时，
// 注入 -gs 让 maven 读取该全局配置（mirror/proxy）。用 shell 函数包裹 mvn，避免改写用户原始命令；
// 用户已显式带 -gs 时不再注入（避免重复参数导致 maven 报错）。
func injectMavenGlobalSettingsFlag(fullCmd string) string {
	if !strings.Contains(fullCmd, "mvn") || strings.Contains(fullCmd, "-gs") {
		return fullCmd
	}
	return fmt.Sprintf("mvn(){ command mvn -gs %s \"$@\"; }\n", mavenGlobalSettingsMountPath) + fullCmd
}

// maskCommandPasswords 把 shell 命令里 https://user:password@host 这类 URL 中的 password
// 替换为 ***，避免真密码落到日志/审计里。仅识别 URL userinfo 段，命令其余部分不动。
//
// 匹配 scheme://userinfo@host，userinfo 含 ":" 时视为带密码并把 : 之后内容换成 ***；
// 无 ":" 视为无密码保持原样。同一条命令里出现多个 URL 也逐一处理。
func maskCommandPasswords(cmd string) string {
	return urlWithCredRegex.ReplaceAllStringFunc(cmd, func(match string) string {
		schemeEnd := strings.Index(match, "://")
		if schemeEnd < 0 {
			return match
		}
		rest := match[schemeEnd+3:]
		at := strings.LastIndex(rest, "@")
		if at < 0 {
			return match
		}
		userinfo := rest[:at]
		hostAndRest := rest[at:]
		colon := strings.Index(userinfo, ":")
		if colon < 0 {
			// 没密码保持原样
			return match
		}
		return match[:schemeEnd+3] + userinfo[:colon] + ":***" + hostAndRest
	})
}

// urlWithCredRegex 匹配带 userinfo 的 URL（如 https://user:pass@host[:port][/path...]）。
// userinfo 与 host 段都不含 /、空白、引号、?、# —— 这些字符基本就是 URL 主体结束标志。
var urlWithCredRegex = regexp.MustCompile(`[a-zA-Z][a-zA-Z0-9+.\-]*://[^/\s'"?#]+@[^/\s'"?#]+`)

// imageRefSteps 已有镜像节点：直接引用给定镜像，作为后续部署的镜像来源。
// 注意：本阶段不执行任何 shell 命令（仅记录镜像引用），所以日志行不能以 "$ " 开头，
// 否则 execute() 的真 exec 路径会把 "referencing image: ..." 当成命令去 kubectl exec，报 not found。
func (e *Engine) imageRefSteps(img string, cid uint) []string {
	if img == "" {
		// 兜底：用户未配置且未指定镜像时，用其配置的「首个镜像仓库」+ 占位 imageName，
		// 避免硬编码 registry.local 把真实仓库冲掉（用户实际仓库由 SETTINGS 决定）。
		if h := e.firstRegistryHost(cid); h != "" {
			img = h + "/default:latest"
		} else {
			img = "default:latest"
		}
	}
	return []string{
		"image reference resolved: " + img,
		"image resolved ✓ （下游「部署」节点将复用该镜像发布到集群）",
	}
}

// pushSteps 推送镜像到镜像仓库。
//   - 若 upstreamImage 非空（上游 docker-build / 已有镜像节点已产出镜像）：仅做 tag（必要时）+ push，不再重复构建；
//     最终镜像引用 target = registry/name:version（registry 缺省 registry.local）。
//   - 若 upstreamImage 为空（兼容旧用法 git → push 直连）：兜底执行 build -t ref . && push。
//
// runtime: "docker"（默认）或 "podman"。podman 模式下命令换为 podman tag / podman push，
// 并在首条命令前自动装 podman（同 dockerBuildSteps）。
//
// 返回最终镜像引用（含 registry，即部署阶段实际发布的镜像）与日志行。
// registryCreds 由 resolveRegistryCreds 提供：包含 host → RegistryCred；非空且该 host 在 creds 里时，
// 会在 cmdLines 头部自动 `cli login --password-stdin` 一次，密码来自 Pod Env（不进命令字符串、不进日志）。
func (e *Engine) pushSteps(cfg string, pipelineName string, upstreamImage string, runtime string, registryCreds map[string]RegistryCred, cid uint) (string, []string) {
	registry := stageConfigString(cfg, "registry")
	if registry == "" {
		// 节点未指定 registry 时依次回退：上游镜像自带的 host → 用户配置的首个仓库 host。
		// 旧版会硬编码 "registry.local" 把真实仓库冲掉（如把 dockerhub.kubekey.local 冲掉）。
		if h := hostOfImage(upstreamImage); h != "" {
			registry = h
		} else if h := e.firstRegistryHost(cid); h != "" {
			registry = h
		}
	}
	project := stageConfigString(cfg, "project")
	imageName := stageConfigString(cfg, "imageName")
	version := stageConfigString(cfg, "version")

	cli := "docker"
	if runtime == "podman" {
		cli = "podman"
	}
	// 跳过 TLS 校验：仅 podman 模式生效，覆盖 push 的 registry ping 与镜像上传。
	// docker 模式依赖节点级 insecure-registries，per-command 无效。
	// 优先级：节点级 insecure 勾选 > 端点级 InsecureTLS（二者任一为真即关闭校验），
	// 与 registryLoginLines 的判定保持一致，否则会出现 login 关校验、push 不关校验的不一致。
	nodeInsecure := runtime == "podman" && stageConfigBool(cfg, "insecure")
	if c, ok := registryCreds[normalizeRegistryHost(registry)]; ok && c.InsecureTLS {
		nodeInsecure = true
	}
	tlsFlag := ""
	if nodeInsecure {
		tlsFlag = " --tls-verify=false"
	}

	// 上游已有镜像：只推送，不重复构建
	if upstreamImage != "" {
		target := upstreamImage
		if !strings.HasPrefix(upstreamImage, registry+"/") {
			name, ver := nameVersionOf(upstreamImage)
			if imageName != "" {
				name = imageName
			}
			// project 覆盖：取 name 末段作为纯镜像名，再拼上 push 指定的 project，
			// 避免上游已含 project 时重复（如 sinopec/openjdk → sinopec/sinopec/openjdk）。
			if project != "" {
				if i := strings.LastIndex(name, "/"); i >= 0 {
					name = name[i+1:]
				}
				name = withProject(project, name)
			}
			if version != "" {
				ver = version
			}
			target = registry + "/" + name + ":" + ver
		}
		lines := []string{}
		if runtime == "podman" {
			lines = append(lines, "$ "+podmanInstallCmd())
		}
		// —— 镜像仓库自动登录（仅当 host 在 registryCreds 里且有非空凭据时）——
		// 密码来自 Pod Env，命令字符串无明文；日志展示行 user 已脱敏。
		loginShell, loginLog := registryLoginPrependLines(cli, registryCreds, nodeInsecure, registry)
		for _, s := range loginShell {
			lines = append(lines, "$ "+s)
		}
		lines = append(lines, loginLog...)
		if target != upstreamImage {
			lines = append(lines, fmt.Sprintf("$ %s tag %s %s", cli, upstreamImage, target))
		}
		lines = append(lines,
			fmt.Sprintf("$ %s push%s %s", cli, tlsFlag, target),
			fmt.Sprintf("The push refers to repository [%s]", target),
			fmt.Sprintf("digest: sha256:%s size: 12.4MB", randHex(12)),
			"Pushed in 3.2s ✓",
		)
		return target, lines
	}

	// 无上游镜像：兜底 build & push（旧用法）
	if imageName == "" {
		imageName = sanitizeImageName(pipelineName)
	}
	if version == "" {
		version = genVersion()
	}
	ref := registry + "/" + withProject(project, imageName) + ":" + version
	buildCmd := fmt.Sprintf("%s build%s -t %s .", cli, tlsFlag, ref)
	if runtime == "podman" {
		buildCmd = cli + " build --isolation=chroot" + tlsFlag + " -t " + ref + " ."
	}
	pushCmd := fmt.Sprintf("%s push%s %s", cli, tlsFlag, ref)
	lines := []string{}
	if runtime == "podman" {
		lines = append(lines, "$ "+podmanInstallCmd())
	}
	// —— 镜像仓库自动登录（build 的 FROM pull 与 push 都依赖）——
	loginShell, loginLog := registryLoginPrependLines(cli, registryCreds, nodeInsecure, registry)
	for _, s := range loginShell {
		lines = append(lines, "$ "+s)
	}
	lines = append(lines, loginLog...)
	lines = append(lines, "$ "+buildCmd)
	lines = append(lines,
		"Step 1/5 : FROM scratch",
		"Step 2/5 : COPY dist/ /app",
		"Step 3/5 : ENTRYPOINT [\"/app/server\"]",
		"Successfully built "+randHex(12),
		"$ "+pushCmd,
		"The push refers to repository ["+ref+"]",
		"digest: sha256:"+randHex(12)+" size: 12.4MB",
		"Pushed in 3.2s ✓",
	)
	return ref, lines
}

func maskURL(repo, user string) string {
	if i := strings.Index(repo, "://"); i >= 0 {
		return repo[:i+3] + user + ":***@" + repo[i+3:]
	}
	if strings.HasPrefix(repo, "git@") {
		return repo // SSH 形式不把密码写进 URL
	}
	return repo
}

// genVersion 生成随机版本号：v + 日期 + 4 位随机十六进制。
func genVersion() string {
	return "v" + time.Now().Format("20060102") + "-" + randHex(4)
}

func randHex(n int) string {
	const hx = "0123456789abcdef"
	b := make([]byte, n)
	for i := range b {
		b[i] = hx[rand.Intn(len(hx))]
	}
	return string(b)
}

// sanitizeImageName 把流水线名转成合法镜像名（小写、非 [a-z0-9._-] 替换为 -）。
func sanitizeImageName(s string) string {
	s = strings.ToLower(s)
	s = strings.ReplaceAll(s, " ", "-")
	s = strings.ReplaceAll(s, "_", "-")
	var b strings.Builder
	for _, r := range s {
		if (r >= 'a' && r <= 'z') || (r >= '0' && r <= '9') || r == '.' || r == '-' {
			b.WriteRune(r)
		}
	}
	out := b.String()
	if out == "" {
		out = "app"
	}
	return out
}

// stripRegistry 去掉镜像引用里的 registry 主机前缀（如 registry.local/app:v1 → app:v1）。
func stripRegistry(ref string) string {
	if i := strings.Index(ref, "/"); i > 0 {
		host := ref[:i]
		if strings.ContainsAny(host, ".:") {
			return ref[i+1:]
		}
	}
	return ref
}

// hostOfImage 返回镜像引用里的 registry 主机前缀；无主机（仅 project/image:tag）时返回空。
func hostOfImage(ref string) string {
	if i := strings.Index(ref, "/"); i > 0 {
		host := ref[:i]
		if strings.ContainsAny(host, ".:") {
			return host
		}
	}
	return ""
}

// normalizeRegistryHost 把 registry host 归一化为「小写、去掉端口」形式，
// 用于凭据匹配：已配 RegistryEndpoint 的 host 来自 URL.Hostname()（无端口），
// 而镜像引用 / 节点 registry 字段可能是 "host:5000" 形态。统一去端口后才能命中 creds key。
func normalizeRegistryHost(h string) string {
	h = strings.ToLower(strings.TrimSpace(h))
	if host, _, err := net.SplitHostPort(h); err == nil {
		return host
	}
	return h
}

// withProject 把项目名（仓库组织 / 命名空间）作为路径前缀拼到镜像名前；
// project 为空时原样返回 name（向后兼容旧数据）。完整镜像路径为
// <registry>/<project>/<imageName>:<version>，如 192.168.11.203/sinopec/openjdk:17。
func withProject(project, name string) string {
	if project == "" {
		return name
	}
	return project + "/" + name
}

// hostFromRegistryURL 把用户配置的 RegistryEndpoint.URL（如 https://dockerhub.kubekey.local）
// 解析为纯 hostname（dockerhub.kubekey.local）。解析失败返回空串。
func hostFromRegistryURL(rawURL string) string {
	if rawURL == "" {
		return ""
	}
	u, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil {
		return ""
	}
	return u.Hostname()
}

// firstRegistryHost 返回用户在 SETTINGS 里配置的首个可用镜像仓库的 hostname。
// 用于「镜像构建」「推送镜像」「已有镜像」等节点未显式选 registry 时的合理回退，
// 优先于硬编码的 "registry.local"。无任何已配置仓库时返回空串。
//
// 实际查询失败不会阻断构建 —— 只是回退为空，由后续阶段（docker-build / push）自行报错或使用空 ref。
func (e *Engine) firstRegistryHost(cid uint) string {
	if e == nil || e.store == nil {
		return ""
	}
	list, err := e.store.RegistryEndpoints(cid)
	if err != nil || len(list) == 0 {
		return ""
	}
	for _, ep := range list {
		if h := hostFromRegistryURL(ep.URL); h != "" {
			return h
		}
	}
	return ""
}

// nameVersionOf 从镜像引用解析出 name 与 version（按最后一个 : 分割）。
func nameVersionOf(ref string) (string, string) {
	r := stripRegistry(ref)
	if i := strings.LastIndex(r, ":"); i > 0 {
		return r[:i], r[i+1:]
	}
	return r, "latest"
}

// dockerBuildSteps 用 Dockerfile 构建镜像（仅构建，不推送）。
//   - 用户直接编写 Dockerfile 内容（dockerfileContent）时：构建时先写入 .dockerfile.gen 再 -f 引用，
//     日志会把内容完整回显，便于核对；
//   - 兼容旧数据仍带 dockerfile 路径时：直接用该路径；
//     两者都缺省时回退到仓库根目录的 ./Dockerfile。
// 支持 --build-arg。若「镜像构建」节点指定了镜像仓库，返回的镜像引用直接带 registry 前缀
// （如 192.168.11.203/sinopec/openjdk:17）；否则仅 project 层级，由后续 push 节点沿用或补上 registry。
// runtime: "docker"（默认，需 docker daemon）或 "podman"（daemonless，K8s Pod 内无需 dind）。
// registryCreds：host → RegistryCred，由 execute() 一次解析后传进来；非空且该 host 在 creds 里时，
// 自动在 cmdLines 头部加 `cli login --password-stdin` 一次，密码从 Pod Env 读，不进命令字符串。
func (e *Engine) dockerBuildSteps(cfg string, pipelineName string, runtime string, registryCreds map[string]RegistryCred, cid uint) (string, []string) {
	dockerfileContent := stageConfigString(cfg, "dockerfileContent")
	context := stageConfigString(cfg, "context")
	if context == "" {
		context = "."
	}
	imageName := stageConfigString(cfg, "imageName")
	project := stageConfigString(cfg, "project")
	registry := stageConfigString(cfg, "registry")
	if registry == "" {
		// 镜像构建节点未指定仓库时，回退到用户在 SETTINGS 里配置的首个镜像仓库（如 dockerhub.kubekey.local），
		// 避免旧版硬编码 "registry.local" 把真实仓库冲掉。
		registry = e.firstRegistryHost(cid)
	}
	if imageName == "" {
		imageName = sanitizeImageName(pipelineName)
	}
	version := stageConfigString(cfg, "version")
	if version == "" {
		version = genVersion()
	}
	// 若用户在「镜像构建」节点选择了镜像仓库，则本地 tag 直接带上 registry 前缀
	// （如 192.168.11.203/sinopec/openjdk:17）；否则仅 project 层级，由后续 push 节点补上 registry。
	ref := withProject(project, imageName) + ":" + version
	if registry != "" {
		ref = registry + "/" + ref
	}

	// 确定 docker build -f 引用的文件：优先用用户编写的 Dockerfile 内容（写入临时文件），
	// 否则兼容旧路径字段，再回退 ./Dockerfile。
	dockerfileArg := stageConfigString(cfg, "dockerfile")
	if dockerfileContent != "" {
		dockerfileArg = ".dockerfile.gen"
	}
	if dockerfileArg == "" {
		dockerfileArg = "Dockerfile"
	}

	// 选择容器运行时：docker 走传统 docker build（需 docker daemon）；
	// podman 是 daemonless，可直接在 K8s Pod 内构建。podman build 在容器内运行时需
	// --isolation=chroot（避免嵌套 user namespace 报 permission denied）。
	cli := "docker"
	buildFlag := ""
	nodeInsecure := runtime == "podman" && stageConfigBool(cfg, "insecure")
	// 端点级 InsecureTLS 也关闭校验（与登录命令一致）：节点未勾但仓库配了"跳过 TLS 校验"时，
	// FROM pull 私有基础镜像同样不校验，避免 login 关了、build 没关导致 x509。
	if c, ok := registryCreds[normalizeRegistryHost(registry)]; ok && c.InsecureTLS {
		nodeInsecure = true
	}
	if runtime == "podman" {
		cli = "podman"
		buildFlag = " --isolation=chroot"
		// 用户勾选「跳过 TLS 校验」时，对私有仓库（自签/私有 CA）关闭校验，覆盖 build 的 FROM pull。
		// 注意：仅 podman（daemonless）生效；docker 模式依赖节点级 insecure-registries，per-command 无效。
		if nodeInsecure {
			buildFlag += " --tls-verify=false"
		}
	}
	dockerCmd := fmt.Sprintf("%s build%s -f %s -t %s %s", cli, buildFlag, dockerfileArg, ref, context)
	if buildArgs := strings.TrimSpace(stageConfigString(cfg, "buildArgs")); buildArgs != "" {
		for _, line := range strings.Split(buildArgs, "\n") {
			line = strings.TrimSpace(line)
			if line != "" {
				dockerCmd += " --build-arg " + line
			}
		}
	}

	lines := []string{}
	if runtime == "podman" {
		// podman 守护进程无关，但 baseImage 通常不含 podman（如 openjdk:17/node:20-alpine），
		// 在 Pod 内自动检测包管理器并安装。已装则秒过；首次约 15–25s。
		// apt-get 静默安装，apk/yum/dnf 同理。失败时显式提示用户预装 podman 到 baseImage。
		lines = append(lines, "$ "+podmanInstallCmd())
	}
	// —— 镜像仓库自动登录：build 的 FROM（如 FROM 私有仓库基础镜像）需要先 login ——
	loginShell, loginLog := registryLoginPrependLines(cli, registryCreds, nodeInsecure, registry)
	for _, s := range loginShell {
		lines = append(lines, "$ "+s)
	}
	lines = append(lines, loginLog...)
	if dockerfileContent != "" {
		// 把「写 Dockerfile + 构建」合成一条 "$ " 命令行：真实 exec 路径只执行以 "$ " 开头的行，
		// 之前把 heredoc 正文逐行散在 "$ " 之外，会被当成日志丢弃，导致 heredoc 无正文、构建实际没跑
		// （却显示 ok，误导判断）。合成单条命令后，realExec 会完整执行：先 cat 写入 .dockerfile.gen，再构建。
		heredoc := "cat > .dockerfile.gen <<'DOCKERFILE_EOF'\n" +
			strings.TrimRight(dockerfileContent, "\n") + "\nDOCKERFILE_EOF"
		lines = append(lines, "$ "+heredoc+"\n"+dockerCmd)
	} else {
		lines = append(lines, "$ "+dockerCmd)
	}
	lines = append(lines,
		"Step 1/6 : FROM base",
		"Step 2/6 : WORKDIR /app",
		"Step 3/6 : COPY . /app",
		"Step 4/6 : RUN go build -o /app/bin ./cmd/server",
		"Step 5/6 : EXPOSE 8080",
		"Step 6/6 : ENTRYPOINT [\"/app/bin\"]",
		"Successfully built "+randHex(12),
		fmt.Sprintf("Successfully tagged %s", ref),
		"image built locally ✓ （镜像引用 = "+ref+"，下游「推送镜像」节点会打上仓库地址并推送）",
	)
	return ref, lines
}

// podmanInstallCmd 生成「检测包管理器并安装 podman」的 shell 命令块，用于在临时构建 Pod 内自动准备运行时。
// 已安装则秒过；首次约 15–25s。覆盖 apt（debian/ubuntu）/ apk（alpine）/ dnf（fedora/rhel8+）/ yum（rhel7/centos）
// / microdnf（red hat ubi minimal）。
// rhel/centos 系 podman 在 container-tools module（带正确 runc），直接 dnf install podman 会撞 modular 依赖冲突，
// 因此先尝试 `dnf module install container-tools` 再回退到 EPEL + podman 直装。
func podmanInstallCmd() string {
	return `if ! command -v podman >/dev/null 2>&1; then
  echo "[podman-auto-install] 探针：podman 未安装，开始按 baseImage 的 OS 自动安装 ..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq podman 2>&1 | tail -3 || { echo "[podman-auto-install] apt-get 安装 podman 失败，请在 baseImage 预装 podman"; exit 1; }
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache podman 2>&1 | tail -3 || { echo "[podman-auto-install] apk 安装 podman 失败，请在 baseImage 预装 podman"; exit 1; }
  elif command -v microdnf >/dev/null 2>&1; then
    # Red Hat UBI minimal 镜像
    microdnf install -y --setopt=install_weak_deps=0 podman 2>&1 | tail -5 || { echo "[podman-auto-install] microdnf 安装 podman 失败，请改用 dnf/yum 基础镜像或预装 podman"; exit 1; }
  elif command -v dnf >/dev/null 2>&1; then
    # RHEL/Fedora 优先走 container-tools module（官方方式，runc 依赖正确解析）
    dnf install -y -q @container-tools 2>&1 | tail -5 \
      || (dnf install -y -q epel-release 2>/dev/null || true) && dnf install -y -q podman 2>&1 | tail -5 \
      || { echo "[podman-auto-install] dnf 安装 podman 失败（module + EPEL 均失败），建议在 baseImage 预装 podman 后重试"; exit 1; }
  elif command -v yum >/dev/null 2>&1; then
    # RHEL 7 / CentOS 7
    (yum install -y -q epel-release 2>/dev/null || true) && yum install -y -q podman 2>&1 | tail -5 \
      || { echo "[podman-auto-install] yum 安装 podman 失败（EPEL 不可用？），请在 baseImage 预装 podman"; exit 1; }
  else
    echo "[podman-auto-install] 未识别包管理器（既无 apt/apk/dnf/yum/microdnf），请预装 podman 到 baseImage"; exit 1
  fi
fi
podman --version`
}

func repoURL(repo string) string {
	if strings.HasPrefix(repo, "http") || strings.HasPrefix(repo, "git@") {
		return repo
	}
	return "https://github.com/" + repo + ".git"
}

func repoName(repo string) string {
	repo = strings.TrimSuffix(repo, ".git")
	if i := strings.LastIndex(repo, "/"); i >= 0 {
		return repo[i+1:]
	}
	return repo
}

func fallbackName(s, dflt string) string {
	if s == "" {
		return dflt
	}
	return s
}

func fallbackNs(s, dflt string) string {
	if s == "" {
		return dflt
	}
	return s
}

func fileSize(p string) int64 {
	if p == "" {
		return 0
	}
	return 12 * 1024 * 1024 // 占位：实际由 handler 写入后端记录，这里只给合成日志用
}

func fmtDuration(d time.Duration) string {
	total := int(d.Seconds())
	m := total / 60
	s := total % 60
	if m > 0 {
		return fmt.Sprintf("%dm%02ds", m, s)
	}
	return fmt.Sprintf("%ds", s)
}

// =====================================================================
// 镜像仓库自动登录（解决"docker-build / push 阶段手动 login 才不报 unauthorized"问题）
// =====================================================================

// RegistryCred 镜像仓库凭据快照（host → 凭据）。Password 是明文（AES-GCM 解密后），
// 仅在引擎内部流转；通过 Pod Env 注入构建 Pod（main 容器可见），不写入任何日志。
type RegistryCred struct {
	Host        string // 纯 hostname，如 dockerhub.kubekey.local
	Username    string
	Password    string
	InsecureTLS bool // RegistryEndpoint 上配的"跳过 TLS 校验"标志
}

// sanitizeEnvHost 把 host（如 dockerhub.kubekey.local:8501）转成合法 shell env 后缀
//（大写、. / : / - 转下划线）。用作 DUNHELM_REG_<KIND>_<X> 的后缀。
func sanitizeEnvHost(host string) string {
	s := strings.ReplaceAll(host, ".", "_")
	s = strings.ReplaceAll(s, ":", "_")
	s = strings.ReplaceAll(s, "-", "_")
	return strings.ToUpper(s)
}

// registryEnvVar 生成 Pod env 变量名。kind 取 "USER" / "PW"。
func registryEnvVar(host, kind string) string {
	return "DUNHELM_REG_" + kind + "_" + sanitizeEnvHost(host)
}

// resolveRegistryCreds 返回「所有已配置且非匿名」的镜像仓库凭据（host → RegistryCred）。
//
// 为什么不是只扫描当前流水线的 docker-build / push 阶段：
// 之前只扫描阶段 cfg.registry 字段，但 push 节点的实际 registry 往往不填在该字段上——
// pushSteps 内部会按 hostOfImage(upstreamImage) 或 e.firstRegistryHost() 兜底解析出真正的
// 目标 host。一旦节点 registry 字段为空，预扫描就漏收，导致自动 login 完全不生成、push 裸奔
// 报 unauthorized（2026-08-17 复现）。改为「全量返回所有已配端点」，由 pushSteps / dockerBuildSteps
// 已正确解析出的 registry host 在 registryLoginPrependLines 里过滤到底给哪个 host 登录，
// 既覆盖显式 registry 字段，也覆盖 hostOfImage / firstRegistryHost 兜底路径。
//
// 匿名端点（用户名或密码为空）排除：公共仓库匿名可拉，主动 login 反而失败。
func (e *Engine) resolveRegistryCreds(p *model.Pipeline) map[string]RegistryCred {
	out := map[string]RegistryCred{}
	if e == nil || e.store == nil {
		return out
	}
	list, err := e.store.RegistryEndpoints(p.ClusterID)
	if err != nil || len(list) == 0 {
		return out
	}
	for _, ep := range list {
		h := strings.ToLower(strings.TrimSpace(hostFromRegistryURL(ep.URL)))
		if h == "" {
			continue
		}
		if _, ok := out[h]; ok {
			continue // 同 host 去重
		}
		if strings.TrimSpace(ep.Username) == "" || ep.Password == "" {
			continue // 匿名端点不注入 login
		}
		out[h] = RegistryCred{
			Host:        h,
			Username:    ep.Username,
			Password:    ep.Password,
			InsecureTLS: ep.InsecureTLS,
		}
	}
	return out
}

// buildPodRegistryEnv 把 creds 转成 Pod Env 列表（每条 registry 两条：USER + PW）。
// 跳过 Password 为空的端点（Docker Hub 部分公共账号可匿名，但匿名场景下 login 反而会失败）。
func buildPodRegistryEnv(creds map[string]RegistryCred) []corev1.EnvVar {
	envs := make([]corev1.EnvVar, 0, len(creds)*2)
	for _, c := range creds {
		if strings.TrimSpace(c.Username) == "" || c.Password == "" {
			continue
		}
		envs = append(envs,
			corev1.EnvVar{Name: registryEnvVar(c.Host, "USER"), Value: c.Username},
			corev1.EnvVar{Name: registryEnvVar(c.Host, "PW"), Value: c.Password},
		)
	}
	return envs
}

// registryLoginLines 生成 "为某个 host 登录一次" 的 shell 命令行 + 日志展示行。
// shell 命令用 `printf '%s' "$DUNHELM_REG_PW_<X>" | <cli> login -u "$DUNHELM_REG_USER_<X>" --password-stdin --tls-verify=<bool> <host>`，
// 密码完全来自 Pod Env，**不进 shell 命令字符串**，也**不进任何日志**。
// 日志展示用 `<cli> login -u *** --password-stdin --tls-verify=<bool> <host>`（USER 脱敏）。
//
// 参数说明：
//   - cli: 容器内实际跑的 CLI（podman / docker），由 pipeline.Runtime 决定
//   - host: 镜像仓库主机名（无 scheme、无端口切前缀）
//   - cred: resolveRegistryCreds 返回的凭据（要求 Password 非空）
//   - nodeInsecure: docker-build / push 节点级 `insecure` 开关（用户在该节点上勾的"跳过 TLS 校验"）
//   - 最终 insecure 优先级：nodeInsecure > cred.InsecureTLS（节点级覆盖）
//
// 返回两条非空字符串：shellCmd（给 execInPod）、logLine（给 stage.Log 展示）。
func registryLoginLines(cli, host string, cred RegistryCred, nodeInsecure bool) (shellCmd string, logLine string) {
	tls := "true"
	if cred.InsecureTLS || nodeInsecure {
		tls = "false"
	}
	userEnv := registryEnvVar(host, "USER")
	pwEnv := registryEnvVar(host, "PW")
	// 关键：'%%s' 是 fmt.Sprintf 转义后的 '%s'，外层 sprintf 引用 PwEnv / UserEnv 时不会被再解释。
	shellCmd = fmt.Sprintf("printf '%%s' \"$%s\" | %s login -u \"$%s\" --password-stdin --tls-verify=%s %s",
		pwEnv, cli, userEnv, tls, host)
	logLine = fmt.Sprintf("$ %s login -u *** --password-stdin --tls-verify=%s %s",
		cli, tls, host)
	return
}

// registryLoginPrependLines 给一个阶段的 cmdLines 头部加若干 login 步骤。
// 只对 [host, cred] 列表里 host 非空且 cred 有效的项加；同一 host 只加一次。
// 返回 (prependShellLines, prependLogLines)：前者进入 execInPod，后者进入 stage.Log。
func registryLoginPrependLines(cli string, creds map[string]RegistryCred, nodeInsecure bool, hosts ...string) (prependShell []string, prependLog []string) {
	seen := map[string]bool{}
	for _, h := range hosts {
		h = normalizeRegistryHost(h)
		if h == "" || seen[h] {
			continue
		}
		seen[h] = true
		cred, ok := creds[h]
		if !ok || cred.Password == "" || strings.TrimSpace(cred.Username) == "" {
			continue
		}
		shell, log := registryLoginLines(cli, h, cred, nodeInsecure)
		prependShell = append(prependShell, shell)
		prependLog = append(prependLog, log)
	}
	return
}