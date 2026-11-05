package camoufoxnative

import (
	"errors"
	"io"
	"net/http"
	"time"
)

// ErrAuthenticationRequired 表示隔离账户需要恢复登录
var ErrAuthenticationRequired = errors.New("隔离登录态失效")

// ErrRegionNotSupported 表示 AI Studio 不支持当前出口地区或账户
var ErrRegionNotSupported = errors.New("AI Studio 不支持当前出口地区或账户，为该账户或全局代理换用支持地区的出口")

// AvailableRegionsURL 是官网在地区或账户不受支持时跳转的页面
const AvailableRegionsURL = "https://aistudio.google.com/docs/available-regions"

// StartupStage 表示 Camoufox runtime 的启动阶段
type StartupStage string

const (
	// StartupPreparingRuntime 表示正在准备 Firefox 宿主配置
	StartupPreparingRuntime StartupStage = "preparing_runtime"
	// StartupLoadingAIStudio 表示正在载入 AI Studio 页面
	StartupLoadingAIStudio StartupStage = "loading_ai_studio"
	// StartupLocatingWAA 表示正在定位 WAA 服务
	StartupLocatingWAA StartupStage = "locating_waa"
	// StartupBootstrappingWAA 表示正在执行 WAA Bootstrap
	StartupBootstrappingWAA StartupStage = "bootstrapping_waa"
)

// Options contains account fingerprint and SpiderMonkey runtime inputs only.
type Options struct {
	StorageStatePath string
	Model            string
	Locale           string
	Timezone         string
	Proxy            string
	AuthUser         int
	CacheDirectory   string
	ReadyTimeout     time.Duration
	StartupProgress  func(StartupStage)
}

func (options Options) reportStartup(stage StartupStage) {
	if options.StartupProgress != nil {
		options.StartupProgress(stage)
	}
}

// State 返回原生 runtime 的当前页面与 bootstrap 结果
type State struct {
	PID         int
	PageURL     string
	UserAgent   string
	SnapshotKey string
	Headers     http.Header
}

// PageCatalog 是会话页面载入时 GetLoggingContext、GetAiStudioBenefitTier 与 ListModels 的响应正文
type PageCatalog struct {
	Logging []byte
	Tier    []byte
	Models  []byte
}

type ProtectedResponse struct {
	StatusCode int
	Header     http.Header
	Body       io.ReadCloser
}

func number(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	}
	return 0, false
}
