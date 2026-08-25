package ci

import (
	"context"
	"errors"
	"fmt"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/remotecommand"
	"k8s.io/utils/exec"
)

// execResult 单次 kubectl exec 的执行结果。
type execResult struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

// execStreamFn 流式回调，每收到一行输出（stdout 或 stderr）就调用一次。
// line 不含末尾换行符；stream 取值 "out" 或 "err"。
type execStreamFn func(stream, line string)

// execInPod 在指定 Pod 内执行 shell 命令（经 kubectl exec 等价的 SPDY stream）。
// stdout/stderr 行通过 stream 回调实时回传（用于写入阶段日志）。
// ctx 取消时 exec 会被中断。命令超时由调用方控制（用 context.WithTimeout）。
//
// exitCode 为 0 表示成功；非 0 通常是命令失败。err 仅表示 transport 层错误，
// 命令自身的非零退出码通过 exitCode 体现。
func execInPod(ctx context.Context, cs kubernetes.Interface, restCfg *rest.Config, podName string, command string, stream execStreamFn) (execResult, error) {
	scheme := runtime.NewScheme()
	_ = corev1.AddToScheme(scheme)
	paramCodec := runtime.NewParameterCodec(scheme)
	req := cs.CoreV1().RESTClient().Post().
		Resource("pods").
		Name(podName).
		Namespace(buildNamespace).
		SubResource("exec").
		VersionedParams(&corev1.PodExecOptions{
			Container: "main",
			Command:   []string{"/bin/sh", "-c", command},
			Stdin:     false,
			Stdout:    true,
			Stderr:    true,
			TTY:       false,
		}, paramCodec)

	executor, err := remotecommand.NewSPDYExecutor(restCfg, "POST", req.URL())
	if err != nil {
		return execResult{}, fmt.Errorf("构建 SPDY 执行器失败: %w", err)
	}

	outBuf := &lineBuf{stream: "out", onLine: stream}
	errBuf := &lineBuf{stream: "err", onLine: stream}

	err = executor.StreamWithContext(ctx, remotecommand.StreamOptions{
		Stdout: outBuf,
		Stderr: errBuf,
	})
	res := execResult{Stdout: outBuf.String(), Stderr: errBuf.String()}
	if err != nil {
		var exitErr exec.CodeExitError
		if errors.As(err, &exitErr) {
			res.ExitCode = exitErr.Code
			return res, nil
		}
		return res, err
	}
	res.ExitCode = 0
	return res, nil
}

// lineBuf io.Writer，每写满一行就回调一次。
type lineBuf struct {
	stream  string
	onLine  execStreamFn
	buf     strings.Builder
	pending []byte
}

func (l *lineBuf) Write(p []byte) (int, error) {
	// 追加到 pending，按 \n 切行
	data := append(l.pending, p...)
	l.pending = nil
	for {
		i := strings.IndexByte(string(data), '\n')
		if i < 0 {
			l.pending = data
			break
		}
		line := string(data[:i])
		l.buf.WriteString(line)
		l.buf.WriteByte('\n')
		if l.onLine != nil {
			l.onLine(l.stream, line)
		}
		data = data[i+1:]
	}
	return len(p), nil
}

func (l *lineBuf) String() string {
	// 末尾未换行的残留也当一行写出（最后一次 flush）
	if len(l.pending) > 0 && l.onLine != nil {
		l.onLine(l.stream, string(l.pending))
		l.buf.WriteString(string(l.pending))
		l.pending = nil
	}
	return l.buf.String()
}