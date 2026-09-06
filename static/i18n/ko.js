(() => {
  "use strict";

  // Keep translations outside upstream-owned HTML so upstream rebases only
  // touch this local dictionary when labels are added or changed.
  const exact = new Map(Object.entries({
    "管理控制台 - Flow2API": "관리 콘솔 - Flow2API",
    "登录 - Flow2API": "로그인 - Flow2API",
    "Flow2API 模型测试": "Flow2API 모델 테스트",
    "管理员控制台": "관리자 콘솔",
    "账户": "계정",
    "密码": "비밀번호",
    "请输入账户": "계정을 입력하세요",
    "请输入密码": "비밀번호를 입력하세요",
    "登录": "로그인",
    "登录中...": "로그인 중...",
    "登录失败": "로그인 실패",
    "网络错误,请稍后重试": "네트워크 오류입니다. 잠시 후 다시 시도하세요",
    "退出": "로그아웃",
    "GitHub 仓库": "GitHub 저장소",
    "Token 管理": "토큰 관리",
    "系统配置": "시스템 설정",
    "请求日志": "요청 로그",
    "测试页面": "테스트 페이지",
    "Token 总数": "전체 토큰",
    "活跃 Token": "활성 토큰",
    "今日图片/总图片": "오늘 이미지/전체 이미지",
    "今日视频/总视频": "오늘 동영상/전체 동영상",
    "今日错误/总错误": "오늘 오류/전체 오류",
    "Token 列表": "토큰 목록",
    "自动刷新AT": "AT 자동 갱신",
    "Token距离过期<1h时自动使用ST刷新AT": "토큰 만료가 1시간 이내이면 ST로 AT를 자동 갱신합니다",
    "刷新": "새로고침",
    "导出所有Token": "모든 토큰 내보내기",
    "导出": "내보내기",
    "导入Token": "토큰 가져오기",
    "导入": "가져오기",
    "新增": "추가",
    "邮箱": "이메일",
    "状态": "상태",
    "协议": "프로토콜",
    "过期时间": "만료 시간",
    "余额": "잔액",
    "类型": "유형",
    "项目ID": "프로젝트 ID",
    "图片": "이미지",
    "视频": "동영상",
    "错误": "오류",
    "操作": "작업",
    "安全配置": "보안 설정",
    "管理员用户名": "관리자 사용자명",
    "旧密码": "기존 비밀번호",
    "新密码": "새 비밀번호",
    "输入旧密码": "기존 비밀번호 입력",
    "输入新密码": "새 비밀번호 입력",
    "修改密码": "비밀번호 변경",
    "API 密钥配置": "API 키 설정",
    "当前 API Key": "현재 API 키",
    "当前使用的 API Key（只读）": "현재 사용 중인 API 키(읽기 전용)",
    "新 API Key": "새 API 키",
    "输入新的 API Key": "새 API 키 입력",
    "用于客户端调用 API 的密钥": "클라이언트 API 호출에 사용할 키",
    "更新 API Key": "API 키 변경",
    "代理配置": "프록시 설정",
    "启用请求代理": "요청 프록시 사용",
    "请求代理地址": "요청 프록시 주소",
    "http://127.0.0.1:7890 或 socks5://127.0.0.1:1080": "http://127.0.0.1:7890 또는 socks5://127.0.0.1:1080",
    "http://127.0.0.1:7897 或 socks5://127.0.0.1:1080": "http://127.0.0.1:7897 또는 socks5://127.0.0.1:1080",
    "http://host:port 或 socks5://host:port": "http://host:port 또는 socks5://host:port",
    "支持 HTTP 和 SOCKS5 代理": "HTTP 및 SOCKS5 프록시를 지원합니다",
    "媒体上传下载代理": "미디어 업로드·다운로드 프록시",
    "启用后，图片上传与图片/视频缓存下载可单独走该代理": "사용하면 이미지 업로드와 이미지·동영상 캐시 다운로드에 별도 프록시를 적용합니다",
    "媒体上传下载代理地址": "미디어 업로드·다운로드 프록시 주소",
    "测试代理": "프록시 테스트",
    "保存配置": "설정 저장",
    "测试目标：": "테스트 대상:",
    "生成配置": "생성 설정",
    "图片生成超时时间（秒）": "이미지 생성 제한 시간(초)",
    "视频生成超时时间（秒）": "동영상 생성 제한 시간(초)",
    "最大重试次数": "최대 재시도 횟수",
    "视频生成超时时间，范围：60-7200 秒（1分钟-2小时），超时后返回上游API超时错误": "동영상 생성 제한 시간은 60~7200초(1분~2시간)이며, 초과 시 upstream API 시간 초과 오류를 반환합니다",
    "生成、上传、轮询等请求失败时的最大重试次数，最小值为 1": "생성·업로드·상태 확인 요청 실패 시 최대 재시도 횟수이며 최솟값은 1입니다",
    "Token 轮询配置": "토큰 순환 설정",
    "调用模式": "호출 방식",
    "轮询模式": "순환 모드",
    "随机轮询": "무작위 순환",
    "随机轮询（默认）": "무작위 순환(기본값)",
    "顺序轮询": "순차 순환",
    "随机轮询使用默认负载优先策略；顺序轮询会按可用Token的稳定顺序依次使用，全部轮完后再开始下一轮。": "무작위 순환은 기본 부하 우선 전략을 사용합니다. 순차 순환은 사용 가능한 토큰을 고정된 순서로 모두 사용한 뒤 다음 순환을 시작합니다.",
    "错误处理配置": "오류 처리 설정",
    "错误次数阈值": "오류 횟수 임계값",
    "错误封禁阈值": "오류 차단 임계값",
    "Token 连续错误达到此次数后自动禁用": "토큰의 연속 오류가 이 횟수에 도달하면 자동으로 비활성화합니다",
    "缓存配置": "캐시 설정",
    "启用缓存": "캐시 사용",
    "缓存超时时间（秒）": "캐시 제한 시간(초)",
    "缓存访问域名": "캐시 접근 도메인",
    "关闭后，生成的图片和视频将直接输出原始链接，不会缓存到本地": "끄면 생성된 이미지와 동영상의 원본 링크를 바로 반환하며 로컬에 캐시하지 않습니다",
    "复制": "복사",
    "随机": "무작위 생성",
    "插件连接配置": "확장프로그램 연결 설정",
    "连接接口": "연결 주소",
    "Chrome扩展插件需要配置此接口地址": "Chrome 확장프로그램에 이 연결 주소를 설정하세요",
    "连接Token": "연결 토큰",
    "留空自动生成": "비워두면 자동 생성",
    "用于验证Chrome扩展插件的身份，留空将自动生成随机token": "Chrome 확장프로그램 인증에 사용합니다. 비워두면 임의 토큰을 자동 생성합니다",
    "更新token时自动启用": "토큰 갱신 시 자동 활성화",
    "当插件更新token时，如果该token被禁用，则自动启用它": "확장프로그램이 토큰을 갱신할 때 비활성 토큰을 자동으로 활성화합니다",
    "使用说明：": "사용 안내:",
    "安装Chrome扩展后，将连接接口和Token配置到插件中，插件会自动提取Google Labs的cookie并更新到系统": "Chrome 확장프로그램 설치 후 연결 주소와 토큰을 입력하면 Google Labs 쿠키를 자동으로 가져와 시스템에 갱신합니다",
    "验证码配置": "CAPTCHA 설정",
    "打码方式": "CAPTCHA 처리 방식",
    "YesCaptcha打码": "YesCaptcha",
    "CapMonster打码": "CapMonster",
    "EzCaptcha打码": "EzCaptcha",
    "CapSolver打码": "CapSolver",
    "Chrome扩展打码": "Chrome 확장프로그램",
    "有头浏览器打码": "화면 표시 브라우저(Playwright)",
    "内置浏览器打码": "내장 브라우저(nodriver)",
    "远程有头打码": "원격 화면 표시 브라우저",
    "选择验证码获取方式": "CAPTCHA 토큰을 가져올 방식을 선택하세요",
    "Chrome扩展打码：": "Chrome 확장프로그램:",
    "验证码由已登录 Google Labs 的 Chrome 页面生成。每个 Token 的“扩展路由”必须与在线扩展路由一致。": "로그인된 Google Labs Chrome 페이지에서 CAPTCHA 토큰을 생성합니다. 각 토큰의 확장 라우트가 온라인 확장 라우트와 일치해야 합니다.",
    "正在检查扩展连接状态...": "확장프로그램 연결 상태를 확인하는 중...",
    "YesCaptcha API密钥": "YesCaptcha API 키",
    "请输入YesCaptcha API密钥": "YesCaptcha API 키 입력",
    "用于自动获取reCAPTCHA验证码，留空则不使用验证码": "reCAPTCHA 토큰 자동 획득에 사용합니다. 비워두면 사용하지 않습니다",
    "YesCaptcha API地址": "YesCaptcha API 주소",
    "YesCaptcha服务地址，默认：https://api.yescaptcha.com": "YesCaptcha 서비스 주소입니다. 기본값: https://api.yescaptcha.com",
    "S7/S9 会随 createTask 强制提交 minScore 0.7/0.9。": "S7/S9는 createTask 호출 시 minScore 0.7/0.9를 강제로 전송합니다.",
    "用于自动获取reCAPTCHA验证码": "reCAPTCHA 토큰 자동 획득에 사용합니다",
    "CapMonster API密钥": "CapMonster API 키",
    "请输入CapMonster API密钥": "CapMonster API 키 입력",
    "CapMonster API地址": "CapMonster API 주소",
    "EzCaptcha API密钥": "EzCaptcha API 키",
    "请输入EzCaptcha API密钥": "EzCaptcha API 키 입력",
    "EzCaptcha API地址": "EzCaptcha API 주소",
    "CapSolver API密钥": "CapSolver API 키",
    "请输入CapSolver API密钥": "CapSolver API 키 입력",
    "CapSolver API地址": "CapSolver API 주소",
    "浏览器打码：": "Playwright 브라우저:",
    "使用Playwright自动化浏览器获取验证码，无需额外配置，但会占用更多系统资源": "Playwright 자동화 브라우저로 CAPTCHA 토큰을 가져옵니다. 별도 설정은 없지만 시스템 자원을 더 사용합니다",
    "启用代理": "프록시 사용",
    "为有头浏览器配置独立代理": "화면 표시 브라우저에 별도 프록시를 설정합니다",
    "代理地址": "프록시 주소",
    "支持：": "지원:",
    "示例：": "예시:",
    "浏览器数量": "브라우저 수",
    "同时启动的浏览器实例数量，每个浏览器只开1个标签页，请求轮询分配": "동시에 실행할 브라우저 인스턴스 수입니다. 브라우저마다 탭 하나를 열고 요청을 순환 배정합니다",
    "扩展路由": "확장 라우트",
    "- Chrome扩展模式": "- Chrome 확장 모드",
    "必须与扩展连接时显示的 route_key 完全一致": "확장 연결에 표시되는 route_key와 정확히 일치해야 합니다",
    "内置浏览器打码：": "내장 브라우저:",
    "使用nodriver自动化浏览器获取验证码，支持标签页复用，性能更优": "nodriver 자동화 브라우저로 CAPTCHA 토큰을 가져옵니다. 탭 재사용을 지원합니다",
    "浏览器实例数量": "브라우저 인스턴스 수",
    "单 Token 项目池大小": "토큰별 프로젝트 풀 크기",
    "单实例最大标签页": "인스턴스별 최대 탭 수",
    "重置码数": "브라우저 재시작 기준 토큰 수",
    "标签空闲超时(秒)": "탭 유휴 제한 시간(초)",
    "标签页空闲多久后自动回收，默认600秒(10分钟)": "탭이 유휴 상태인 뒤 자동 회수할 시간입니다. 기본값은 600초(10분)입니다",
    "为内置浏览器配置独立代理（优先级高于全局请求代理）": "내장 브라우저에 별도 프록시를 설정합니다(전역 요청 프록시보다 우선)",
    "远程有头打码：": "원격 화면 표시 브라우저:",
    "通过 HTTP 调用独立打码服务获取 token，并在请求结束后回调 finish/error": "HTTP로 별도 서비스에서 토큰을 가져오고 요청 종료 후 finish/error를 호출합니다",
    "远程服务 Base URL": "원격 서비스 기본 URL",
    "远程服务 API Key": "원격 서비스 API 키",
    "远程请求超时（秒）": "원격 요청 제한 시간(초)",
    "调试配置": "디버그 설정",
    "启用调试模式": "디버그 모드 사용",
    "开启后，详细的上游API请求和响应日志将写入": "사용하면 상세한 upstream API 요청·응답 로그를 다음 파일에 기록합니다:",
    "文件": "",
    "注意：": "주의:",
    "调试模式会产生非常非常大量的日志，仅限Debug时候开启，否则磁盘boom": "디버그 모드는 매우 많은 로그를 생성합니다. 문제를 조사할 때만 사용하세요",
    "✅ 开关状态自动保存": "✅ 변경 즉시 자동 저장",
    "日志列表": "로그 목록",
    "全部": "전체",
    "成功": "성공",
    "失败": "실패",
    "进行中": "진행 중",
    "搜索": "검색",
    "清空日志": "로그 비우기",
    "时间": "시간",
    "耗时": "소요 시간",
    "详情": "상세",
    "上一页": "이전",
    "下一页": "다음",
    "新增 Token": "토큰 추가",
    "编辑 Token": "토큰 편집",
    "备注": "메모",
    "名称": "이름",
    "启用": "활성화",
    "取消": "취소",
    "保存": "저장",
    "删除": "삭제",
    "确认删除": "삭제 확인",
    "关闭": "닫기",
    "导入 Token": "토큰 가져오기",
    "选择文件": "파일 선택",
    "模型测试": "모델 테스트",
    "🧪 Flow2API 模型测试": "🧪 Flow2API 모델 테스트",
    "选择模型，输入提示词，测试生成效果": "모델과 프롬프트를 선택해 생성 결과를 테스트합니다",
    "地址:": "주소:",
    "输入 API Key": "API 키 입력",
    "未填写 API Key 或模型列表加载失败时，会回退到内置候选模型；实际生成前仍需填写有效 API Key。": "API 키가 없거나 모델 목록을 불러오지 못하면 내장 모델 목록을 표시합니다. 실제 생성 전에는 유효한 API 키가 필요합니다.",
    "请选择模型": "모델을 선택하세요",
    "从左侧列表选择一个模型开始测试": "왼쪽 목록에서 테스트할 모델을 선택하세요",
    "提示词 (Prompt)": "프롬프트(Prompt)",
    "描述你想生成的内容...": "생성할 내용을 설명하세요...",
    "一只可爱的橘猫趴在窗台上晒太阳，窗外是樱花盛开的春天": "귀여운 치즈 고양이가 창가에서 햇볕을 쬐고 있고, 창밖에는 벚꽃이 만개한 봄날",
    "上传图片": "이미지 업로드",
    "点击或拖拽上传图片": "클릭하거나 이미지를 끌어다 놓으세요",
    "选择模型后开始生成": "모델 선택 후 생성 시작",
    "等待中": "대기 중",
    "准备就绪，选择模型并点击生成按钮开始...": "준비되었습니다. 모델을 선택하고 생성 버튼을 누르세요...",
    "图片生成": "이미지 생성",
    "视频生成": "동영상 생성",
    "视频放大 (Upsample)": "동영상 업스케일(Upsample)",
    "生成中...": "생성 중...",
    "开始生成": "생성 시작",
    "完成": "완료",
    "加载中...": "불러오는 중...",
    "暂无数据": "데이터 없음",
    "暂无日志": "로그 없음",
    "配置保存成功": "설정을 저장했습니다",
    "保存失败": "저장 실패",
    "验证码配置保存成功": "CAPTCHA 설정을 저장했습니다",
    "插件配置保存成功": "확장프로그램 설정을 저장했습니다",
    "代理配置保存成功": "프록시 설정을 저장했습니다",
    "生成配置保存成功": "생성 설정을 저장했습니다"
  }));

  const phrases = [
    [/图片生成超时时间，范围：60-3600 秒（1分钟-1小时），超时后自动释放Token锁/g, "이미지 생성 제한 시간은 60~3600초(1분~1시간)이며, 초과 시 토큰 잠금을 자동 해제합니다"],
    [/视频生成超时时间，范围：60-7200 秒（1分钟-2小时），超时后自动释放Token锁/g, "동영상 생성 제한 시간은 60~7200초(1분~2시간)이며, 초과 시 토큰 잠금을 자동 해제합니다"],
    [/HTTP\/HTTPS\/SOCKS5\/SOCKS5H 代理，均支持带认证/g, "HTTP/HTTPS/SOCKS5/SOCKS5H 프록시와 인증을 지원합니다"],
    [/personal 模式真实浏览器实例数。/g, "personal 모드의 실제 브라우저 인스턴스 수입니다."],
    [/有效槽位约等于 实例数 × 单实例标签页，上限 50。/g, "유효 슬롯은 인스턴스 수 × 인스턴스별 탭 수이며 최대 50개입니다."],
    [/只影响该 Token 可轮换的 project_id 数量，不决定打码标签页数。/g, "이 토큰이 순환할 project_id 수에만 영향을 주며 CAPTCHA 탭 수를 결정하지 않습니다."],
    [/打码标签页由全局共享池统一复用。/g, "CAPTCHA 탭은 전역 공유 풀에서 재사용됩니다."],
    [/每个浏览器最多保留多少个共享打码标签页。/g, "브라우저마다 유지할 공유 CAPTCHA 탭의 최대 개수입니다."],
    [/总并发槽位约为 浏览器实例数 × 这里，上限 50。/g, "전체 동시 슬롯은 브라우저 인스턴스 수 × 이 값이며 최대 50개입니다."],
    [/成功获取多少个码后清理并重启浏览器。/g, "성공적으로 가져온 토큰이 이 수에 도달하면 브라우저를 정리하고 재시작합니다."],
    [/高并发建议 0 或 >=50，5\/10 会频繁重启导致排队。/g, "동시 요청이 많으면 0 또는 50 이상을 권장합니다. 5/10은 잦은 재시작과 대기를 유발합니다."],
    [/第\s*(\d+)\s*页，共\s*(\d+)\s*页/g, "$2페이지 중 $1페이지"],
    [/共\s*(\d+)\s*条/g, "총 $1건"],
    [/耗时\s*([\d.]+)s/g, "소요 시간 $1초"],
    [/错误:\s*/g, "오류: "],
    [/生成失败:\s*/g, "생성 실패: "],
    [/加载失败:\s*/g, "불러오기 실패: "],
    [/保存失败:\s*/g, "저장 실패: "],
    [/删除失败:\s*/g, "삭제 실패: "],
    [/请求失败:\s*/g, "요청 실패: "],
    [/Gemini 3\.1 Flash 图片/g, "Gemini 3.1 Flash 이미지"],
    [/Gemini 3\.0 Pro 图片/g, "Gemini 3.0 Pro 이미지"],
    [/Imagen 4\.0 图片/g, "Imagen 4.0 이미지"],
    [/Veo 3\.1 文生视频 \(T2V\)/g, "Veo 3.1 텍스트→동영상(T2V)"],
    [/Veo 3\.1 图生视频 \(I2V\)/g, "Veo 3.1 이미지→동영상(I2V)"],
    [/Veo 3\.1 多图视频 \(R2V\)/g, "Veo 3.1 다중 이미지→동영상(R2V)"],
    [/视频放大 \(Upsample\)/g, "동영상 업스케일(Upsample)"]
  ];

  const blockedTags = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "CODE", "PRE"]);
  const translatableAttributes = ["placeholder", "title", "aria-label"];
  let applying = false;

  function translate(value) {
    if (typeof value !== "string" || !value.trim()) return value;
    const leading = value.match(/^\s*/)?.[0] || "";
    const trailing = value.match(/\s*$/)?.[0] || "";
    const core = value.slice(leading.length, value.length - trailing.length || undefined);
    let translated = exact.has(core) ? exact.get(core) : core;
    for (const [pattern, replacement] of phrases) {
      translated = translated.replace(pattern, replacement);
    }
    return `${leading}${translated}${trailing}`;
  }

  function translateTextNode(node) {
    const parent = node.parentElement;
    if (!parent || blockedTags.has(parent.tagName)) return;
    const next = translate(node.nodeValue);
    if (next !== node.nodeValue) node.nodeValue = next;
  }

  function translateElement(element) {
    if (!(element instanceof Element) || blockedTags.has(element.tagName)) return;
    for (const attribute of translatableAttributes) {
      if (!element.hasAttribute(attribute)) continue;
      const current = element.getAttribute(attribute);
      const next = translate(current);
      if (next !== current) element.setAttribute(attribute, next);
    }
    if (element instanceof HTMLInputElement && ["button", "submit", "reset"].includes(element.type)) {
      const next = translate(element.value);
      if (next !== element.value) element.value = next;
    }
    if (element instanceof HTMLTextAreaElement && !element.dataset.koLocalized) {
      const next = translate(element.value);
      if (next !== element.value) element.value = next;
      element.dataset.koLocalized = "true";
    }
  }

  function walk(root = document) {
    if (applying) return;
    applying = true;
    try {
      if (root.nodeType === Node.TEXT_NODE) translateTextNode(root);
      if (root.nodeType === Node.ELEMENT_NODE) translateElement(root);

      const elementRoot = root.nodeType === Node.DOCUMENT_NODE ? root.documentElement : root;
      if (!elementRoot) return;
      const elementWalker = document.createTreeWalker(elementRoot, NodeFilter.SHOW_ELEMENT);
      let element = elementWalker.currentNode;
      while (element) {
        translateElement(element);
        element = elementWalker.nextNode();
      }
      const textWalker = document.createTreeWalker(elementRoot, NodeFilter.SHOW_TEXT);
      let textNode = textWalker.nextNode();
      while (textNode) {
        translateTextNode(textNode);
        textNode = textWalker.nextNode();
      }
    } finally {
      applying = false;
    }
  }

  function ensureExtensionOption() {
    const select = document.getElementById("cfgCaptchaMethod");
    if (!(select instanceof HTMLSelectElement) || select.querySelector('option[value="extension"]')) return;
    const option = document.createElement("option");
    option.value = "extension";
    option.textContent = "Chrome 확장프로그램";
    const firstBrowserOption = select.querySelector('option[value="browser"]');
    select.insertBefore(option, firstBrowserOption);
  }

  function start() {
    document.documentElement.lang = "ko";
    document.title = translate(document.title);
    ensureExtensionOption();
    walk(document);

    const observer = new MutationObserver((mutations) => {
      if (applying) return;
      for (const mutation of mutations) {
        if (mutation.type === "characterData") walk(mutation.target);
        for (const node of mutation.addedNodes) walk(node);
      }
    });
    observer.observe(document.body, {childList: true, subtree: true, characterData: true});
  }

  window.Flow2APIKorean = Object.freeze({translate, apply: walk});
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, {once: true});
  } else {
    start();
  }
})();
