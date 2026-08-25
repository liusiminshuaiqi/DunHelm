package ci

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/util/wait"
	"k8s.io/client-go/kubernetes"
)

// buildNamespace 临时构建 Pod 所在的命名空间。所有 CI 阶段共用的 dun-build-XXXX Pod 都跑在这里。
// 这里固定 dunhelm-ci，与 DunHelm 业务 namespace 隔离；不存在则首次启动时自动创建。
const buildNamespace = "dunhelm-ci"

// mavenGlobalConfigMapName 平台级 maven 全局配置（mirror/proxy，无密钥）的固定 ConfigMap 名，
// 挂在每个构建 Pod 的 /opt/dunhelm/maven-global-settings.xml；引擎对含 mvn 的命令注入 -gs 指向它。
// 各 maven 镜像 MAVEN_HOME 路径不一，无法直接覆盖 ${maven.home}/conf/settings.xml，故用固定路径 + -gs。
const mavenGlobalConfigMapName = "dunhelm-ci-maven-global"

// mavenGlobalSettingsMountPath 构建 Pod 内平台级 maven global settings 的固定挂载路径。
const mavenGlobalSettingsMountPath = "/opt/dunhelm/maven-global-settings.xml"

// mavenLocalRepoMountPath 构建 Pod 内 Maven 本地仓库的固定挂载路径（方案C：节点本地盘缓存）。
// 须与平台级全局 settings.xml 的 <localRepository> 一致。放在独立顶层路径，避免与
// /opt/dunhelm（global settings ConfigMap）或 /root/.m2（user settings Secret）的挂载互相嵌套。
const mavenLocalRepoMountPath = "/opt/dunhelm-m2"

// defaultMavenCacheHostPath 方案C 的节点本地盘缓存基路径（hostPath）。每个构建节点把该目录挂进
// 构建 Pod 的 mavenLocalRepoMountPath，构建 Pod 落在哪台节点、该节点的 /data/dunhelm/m2-cache
// 就是哪台的热缓存——天然解决"随机节点"问题（每个节点各自攒缓存，落谁谁热）。
// 可用环境变量 DUNHELM_MAVEN_CACHE_HOSTPATH 覆盖（不同集群节点磁盘布局不同）。
const defaultMavenCacheHostPath = "/data/dunhelm/m2-cache"

// mavenCacheHostPath 实际生效的节点本地缓存基路径（优先取环境变量）。
var mavenCacheHostPath = func() string {
	if v := os.Getenv("DUNHELM_MAVEN_CACHE_HOSTPATH"); strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return defaultMavenCacheHostPath
}()

// npmLocalRepoMountPath 前端（npm / pnpm / yarn）构建的 npm 缓存固定挂载路径（方案C）。
// 对应 npm cacache 目录（npm ci 命中缓存的关键，类比 Maven 的 ~/.m2/repository），
// 通过容器环境变量 NPM_CONFIG_CACHE 指向它，npm ci / npm install 即读写该路径，避免每次全量下载。
const npmLocalRepoMountPath = "/opt/dunhelm-npm"

// defaultNpmCacheHostPath 方案C 的 npm 缓存节点本地盘基路径（hostPath）。与 maven 缓存平行，落点同样随节点天然分布。
// 可用环境变量 DUNHELM_NPM_CACHE_HOSTPATH 覆盖（不同集群节点磁盘布局不同）。
const defaultNpmCacheHostPath = "/data/dunhelm/npm-cache"

// npmCacheHostPath 实际生效的节点本地缓存基路径（优先取环境变量）。
var npmCacheHostPath = func() string {
	if v := os.Getenv("DUNHELM_NPM_CACHE_HOSTPATH"); strings.TrimSpace(v) != "" {
		return strings.TrimSpace(v)
	}
	return defaultNpmCacheHostPath
}()

// normalizeBuilderType 把构建模版归一化为 maven / npm：空或未知等同 maven（历史兼容，旧流水线均为后端 maven）。
// 其它可识别别名：npm / node / nodejs / frontend → npm。
func normalizeBuilderType(b string) string {
	b = strings.ToLower(strings.TrimSpace(b))
	switch b {
	case "npm", "node", "nodejs", "frontend", "yarn", "pnpm":
		return "npm"
	default:
		return "maven"
	}
}

// buildPodOptions 创建临时构建 Pod 时可选的挂载/注入配置：
//   - GlobalMavenSettings：平台级 maven global settings（镜像无关，mirror/proxy，无密钥），非空则挂 ConfigMap；
//   - UserMavenSettings：流水级 maven 用户配置（含 servers/凭证，敏感），非空则挂 Secret 到 /root/.m2/settings.xml；
//   - RegistryEnv：镜像仓库自动登录用的 env 注入（Pod 内 main 容器可见）。
//     每个 registry 两条：<name>_USER / <name>_PW。podman/docker login 通过 --password-stdin 从这些 env 读密码，
//     密码不会出现在 shell 命令字符串或构建日志中。
type buildPodOptions struct {
	GlobalMavenSettings string
	UserMavenSettings   string
	RegistryEnv         []corev1.EnvVar
	// BuilderType 构建模版（maven / npm），决定挂载哪种节点本地盘缓存：
	//   - maven：挂 maven 缓存（/data/dunhelm/m2-cache → /opt/dunhelm-m2）
	//   - npm：挂 npm cacache（/data/dunhelm/npm-cache → /opt/dunhelm-npm），并注入 NPM_CONFIG_CACHE 环境变量
	// 空（兼容旧数据）由 normalizeBuilderType 视为 maven。
	BuilderType string
}

// ensureNamespace 确保指定 namespace 存在（不存在则创建）。已存在返回 nil。
func ensureNamespace(ctx context.Context, cs kubernetes.Interface) error {
	_, err := cs.CoreV1().Namespaces().Get(ctx, buildNamespace, metav1.GetOptions{})
	if err == nil {
		return nil
	}
	if !apierrors.IsNotFound(err) {
		return fmt.Errorf("查询命名空间失败: %w", err)
	}
	_, err = cs.CoreV1().Namespaces().Create(ctx, &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{Name: buildNamespace},
	}, metav1.CreateOptions{})
	if err != nil && !apierrors.IsAlreadyExists(err) {
		return fmt.Errorf("创建命名空间失败: %w", err)
	}
	return nil
}

// createBuildPod 创建一个临时构建 Pod（基于 baseImage，restart=Never），返回 Pod 名。
// 失败返回详细错误（构建引擎会 fallback 到 mock 日志）。
// 整个创建流程（包含 namespace 创建 + Pod 创建）的总超时 1min：集群 apiserver
// 不可达 / image 拉取策略拒绝 时快速失败，避免一直挂着。Pod Create() 内部的 HTTP
// 拨号挂死靠超时 ctx 兜底：goroutine 包装 + select。
func createBuildPod(ctx context.Context, cs kubernetes.Interface, name, baseImage string, buildID uint, opts buildPodOptions) error {
	cctx, cancel := context.WithTimeout(ctx, 1*time.Minute)
	defer cancel()
	if err := ensureNamespace(cctx, cs); err != nil {
		return err
	}
	pod := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{
			Name:      name,
			Namespace: buildNamespace,
			Labels: map[string]string{
				"app":               "dun-build",
				"dunhelm.io/build":  fmt.Sprintf("%d", buildID),
				"dunhelm.io/managed": "kubehelm-ci",
			},
		},
		Spec: corev1.PodSpec{
			RestartPolicy: corev1.RestartPolicyNever,
			Volumes:       buildPodVolumes(name, opts),
			Containers: []corev1.Container{{
				Name:    "main",
				Image:   baseImage,
				Command: []string{"sleep", "3600"}, // 长时间挂起，等 kubectl exec 来跑命令
				// 不挂 tty：exec 不需要 tty 也能跑命令
				// 以 root 运行并把工作目录放到 /root：CI 构建需在 workspace 内写源码 / 编译产物，
				// 多数构建镜像默认以非 root 用户启动且家目录未必可写（如 jenkins 镜像会报
				// "Permission denied" 创建 work tree）。root + /root 是最通用的可写工作区。
			WorkingDir:   "/root",
			VolumeMounts: buildPodVolumeMounts(opts),
		// 镜像仓库自动登录的 env 注入：USER / PW 成对，由 pushSteps / dockerBuildSteps
		// 通过 `cli login --password-stdin` 消费，密码始终不进 shell 命令字符串。
		// 另按构建模版追加缓存相关 env（npm 模式注入 NPM_CONFIG_CACHE 指向 cacache 挂载路径）。
		Env: buildPodEnv(opts),
			SecurityContext: &corev1.SecurityContext{
				RunAsUser:    ptrInt64(0),
				RunAsGroup:   ptrInt64(0),
				RunAsNonRoot: ptrBool(false),
				// privileged: podman/buildah 等 daemonless 容器构建工具仍需特权模式才能
				// 操作 overlayfs / 挂载 / 写 cgroup（尤其是 rootless 之外的默认路径）。
				Privileged: ptrBool(true),
			},
			}},
		},
	}
	// client-go Pods.Create() 不接 ctx，用 goroutine + select 兜底
	type createResult struct {
		err error
	}
	done := make(chan createResult, 1)
	go func() {
		_, err := cs.CoreV1().Pods(buildNamespace).Create(cctx, pod, metav1.CreateOptions{})
		done <- createResult{err: err}
	}()
	select {
	case <-cctx.Done():
		return fmt.Errorf("创建 Pod 超时: %w", cctx.Err())
	case r := <-done:
		if r.err != nil {
			return fmt.Errorf("创建 Pod 失败: %w", r.err)
		}
		return nil
	}
}

// waitPodReady 轮询等待 Pod 进入 Running 状态。超时 3min。
// ctx 取消立即返回。Pod 进入 Failed/Succeeded 终态也会立即返回错误。
// 检测到容器镜像拉取失败 (ErrImagePull / ImagePullBackOff) 或崩溃 (CrashLoopBackOff) 时
// 立即返回错误，避免白白等满 3 分钟（用户能直观看到「集群拉不到 baseImage」+ fallback 到 mock 日志）。
func waitPodReady(ctx context.Context, cs kubernetes.Interface, name string) error {
	const pollInterval = 500 * time.Millisecond
	const pollTimeout = 3 * time.Minute
	return wait.PollUntilContextTimeout(ctx, pollInterval, pollTimeout, true, func(ctx context.Context) (bool, error) {
		p, err := cs.CoreV1().Pods(buildNamespace).Get(ctx, name, metav1.GetOptions{})
		if err != nil {
			if apierrors.IsNotFound(err) {
				return false, nil
			}
			return false, err
		}
		switch p.Status.Phase {
		case corev1.PodRunning:
			return true, nil
		case corev1.PodFailed, corev1.PodSucceeded:
			return false, fmt.Errorf("Pod %s 进入终态 %s，无法执行命令", name, p.Status.Phase)
		}
		// 快速失败：检测到容器处于 ErrImagePull / ImagePullBackOff / CrashLoopBackOff 时立刻返回错误，
		// 让构建引擎立即 fallback 到 mock 日志（用户不用等满 3 分钟）。
		for _, c := range p.Status.ContainerStatuses {
			if c.State.Waiting == nil {
				continue
			}
			switch c.State.Waiting.Reason {
			case "ErrImagePull", "ImagePullBackOff", "InvalidImageName":
				return false, fmt.Errorf("Pod %s 容器 %s 镜像拉取失败 (%s): %s。请改用集群能访问的内网镜像，或在 baseImage 节点选可用的镜像",
					name, c.Name, c.State.Waiting.Reason, c.State.Waiting.Message)
			case "CrashLoopBackOff":
				return false, fmt.Errorf("Pod %s 容器 %s 反复崩溃 (%s): %s。请检查 baseImage 镜像内的启动命令 / sleep 是否兼容",
					name, c.Name, c.State.Waiting.Reason, c.State.Waiting.Message)
			}
		}
		return false, nil
	})
}

// deleteBuildPod 删除临时构建 Pod；不存在视作成功。失败仅返回错误（构建引擎会打印警告但不阻断流程）。
func deleteBuildPod(ctx context.Context, cs kubernetes.Interface, name string) error {
	if name == "" {
		return nil
	}
	err := cs.CoreV1().Pods(buildNamespace).Delete(ctx, name, metav1.DeleteOptions{})
	if err != nil && !apierrors.IsNotFound(err) && !errors.Is(err, context.Canceled) {
		return err
	}
	return nil
}

// deleteBuildPodResources 回收一次构建的全部临时资源：构建 Pod + 本次构建专用的 maven settings Secret。
// 任一不存在均视作成功，不阻断流程（Secret 名由 Pod 名派生：<pod>-maven）。
func deleteBuildPodResources(ctx context.Context, cs kubernetes.Interface, podName string) error {
	if podName == "" {
		return nil
	}
	errPod := deleteBuildPod(ctx, cs, podName)
	errSec := deleteMavenSettingsSecret(ctx, cs, podName)
	if errPod != nil {
		return errPod
	}
	return errSec
}

// buildPodVolumes 根据构建选项组装临时构建 Pod 的卷：
//   - 节点本地盘依赖缓存（方案C）：按构建模版挂 maven 缓存或 npm cacache，二者互斥；
//   - 平台级 maven 全局配置（ConfigMap，挂在 /opt/dunhelm/maven-global-settings.xml），仅当内容非空；
//   - 流水级 maven 用户配置（Secret，挂 /root/.m2/settings.xml，含 servers/凭证），仅当内容非空。
func buildPodVolumes(podName string, opts buildPodOptions) []corev1.Volume {
	vols := []corev1.Volume{}
	// 方案C：节点本地盘缓存卷（hostPath）。DirectoryOrCreate 保证节点目录不存在时自动建，
	// 缓存随节点落点天然分布——每台节点第一次构建后该目录即热，后续同节点构建直接命中。
	// 按构建模版选择挂载哪套缓存（后端 maven / 前端 npm），避免无谓挂载与缓存互相串味。
	bt := normalizeBuilderType(opts.BuilderType)
	if bt == "npm" {
		vols = append(vols, corev1.Volume{
			Name: "npm-local-repo",
			VolumeSource: corev1.VolumeSource{
				HostPath: &corev1.HostPathVolumeSource{
					Path: npmCacheHostPath,
					Type: ptrHostPathType(corev1.HostPathDirectoryOrCreate),
				},
			},
		})
	} else {
		vols = append(vols, corev1.Volume{
			Name: "maven-local-repo",
			VolumeSource: corev1.VolumeSource{
				HostPath: &corev1.HostPathVolumeSource{
					Path: mavenCacheHostPath,
					Type: ptrHostPathType(corev1.HostPathDirectoryOrCreate),
				},
			},
		})
	}
	if strings.TrimSpace(opts.GlobalMavenSettings) != "" {
		vols = append(vols, corev1.Volume{
			Name: "maven-global-settings",
			VolumeSource: corev1.VolumeSource{
				ConfigMap: &corev1.ConfigMapVolumeSource{
					LocalObjectReference: corev1.LocalObjectReference{Name: mavenGlobalConfigMapName},
					Items:                []corev1.KeyToPath{{Key: "settings.xml", Path: "maven-global-settings.xml"}},
				},
			},
		})
	}
	if strings.TrimSpace(opts.UserMavenSettings) != "" {
		vols = append(vols, corev1.Volume{
			Name: "maven-user-settings",
			VolumeSource: corev1.VolumeSource{
				Secret: &corev1.SecretVolumeSource{
					SecretName: podName + "-maven",
					Items:      []corev1.KeyToPath{{Key: "settings.xml", Path: "settings.xml"}},
				},
			},
		})
	}
	return vols
}

// buildPodVolumeMounts 与 buildPodVolumes 对应的挂载点。
func buildPodVolumeMounts(opts buildPodOptions) []corev1.VolumeMount {
	mounts := []corev1.VolumeMount{}
	// 方案C：按构建模版挂载对应依赖缓存（后端 maven 本地仓库 / 前端 npm cacache）。
	bt := normalizeBuilderType(opts.BuilderType)
	if bt == "npm" {
		mounts = append(mounts, corev1.VolumeMount{
			Name:      "npm-local-repo",
			MountPath: npmLocalRepoMountPath,
		})
	} else {
		mounts = append(mounts, corev1.VolumeMount{
			Name:      "maven-local-repo",
			MountPath: mavenLocalRepoMountPath,
		})
	}
	if strings.TrimSpace(opts.GlobalMavenSettings) != "" {
		mounts = append(mounts, corev1.VolumeMount{
			Name:      "maven-global-settings",
			MountPath: "/opt/dunhelm",
		})
	}
	if strings.TrimSpace(opts.UserMavenSettings) != "" {
		mounts = append(mounts, corev1.VolumeMount{
			Name:      "maven-user-settings",
			MountPath: "/root/.m2",
		})
	}
	return mounts
}

// buildPodEnv 组装构建 Pod 容器的额外环境变量。在镜像仓库自动登录 env 之外，按构建模版追加缓存相关 env：
//   - npm 模式：NPM_CONFIG_CACHE 指向 npm cacache 挂载路径（/opt/dunhelm-npm），让 npm ci / npm install 命中节点本地缓存。
func buildPodEnv(opts buildPodOptions) []corev1.EnvVar {
	env := append([]corev1.EnvVar{}, opts.RegistryEnv...)
	if normalizeBuilderType(opts.BuilderType) == "npm" {
		env = append(env, corev1.EnvVar{
			Name:  "NPM_CONFIG_CACHE",
			Value: npmLocalRepoMountPath,
		})
	}
	return env
}

// upsertMavenGlobalConfigMap 把平台级 maven global settings 内容写进固定 ConfigMap
// （namespace dunhelm-ci），供所有构建 Pod 挂载。内容为空则什么都不做（避免挂空文件）。
func upsertMavenGlobalConfigMap(ctx context.Context, cs kubernetes.Interface, content string) error {
	if strings.TrimSpace(content) == "" {
		return nil
	}
	cm, err := cs.CoreV1().ConfigMaps(buildNamespace).Get(ctx, mavenGlobalConfigMapName, metav1.GetOptions{})
	if err != nil {
		if !apierrors.IsNotFound(err) {
			return err
		}
		cm = &corev1.ConfigMap{
			ObjectMeta: metav1.ObjectMeta{Name: mavenGlobalConfigMapName, Namespace: buildNamespace},
			Data:       map[string]string{"settings.xml": content},
		}
		_, err = cs.CoreV1().ConfigMaps(buildNamespace).Create(ctx, cm, metav1.CreateOptions{})
		return err
	}
	if cm.Data == nil {
		cm.Data = map[string]string{}
	}
	cm.Data["settings.xml"] = content
	_, err = cs.CoreV1().ConfigMaps(buildNamespace).Update(ctx, cm, metav1.UpdateOptions{})
	return err
}

// createMavenSettingsSecret 为单次构建创建挂 /root/.m2/settings.xml 的 Secret
// （含 servers/凭证，敏感，故用 Secret 而非 ConfigMap）。Secret 名 = <pod>-maven。
// 内容为空则返回空串（调用方据此不挂该卷）。
func createMavenSettingsSecret(ctx context.Context, cs kubernetes.Interface, podName, content string) (string, error) {
	if strings.TrimSpace(content) == "" {
		return "", nil
	}
	secretName := podName + "-maven"
	sec := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: secretName, Namespace: buildNamespace},
		Type:       corev1.SecretTypeOpaque,
		StringData: map[string]string{"settings.xml": content},
	}
	if _, err := cs.CoreV1().Secrets(buildNamespace).Create(ctx, sec, metav1.CreateOptions{}); err != nil {
		return "", err
	}
	return secretName, nil
}

// deleteMavenSettingsSecret 删除构建 Secret（名 = <pod>-maven）；已不存在视作成功。
func deleteMavenSettingsSecret(ctx context.Context, cs kubernetes.Interface, podName string) error {
	if podName == "" {
		return nil
	}
	err := cs.CoreV1().Secrets(buildNamespace).Delete(ctx, podName+"-maven", metav1.DeleteOptions{})
	if err != nil && !apierrors.IsNotFound(err) && !errors.Is(err, context.Canceled) {
		return err
	}
	return nil
}

// ptrInt64 / ptrBool 是 k8s SecurityContext 字段需要的指针辅助函数。
func ptrInt64(v int64) *int64 { return &v }
func ptrBool(v bool) *bool    { return &v }

// ptrHostPathType 是 k8s HostPath 卷 Type 字段需要的指针辅助函数。
func ptrHostPathType(t corev1.HostPathType) *corev1.HostPathType { return &t }