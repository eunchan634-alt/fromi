"use strict";

/* =========================================================
   졸음 감지 - script.js
   - MediaPipe Face Mesh 로 눈 인식
   - EAR(Eye Aspect Ratio) 로 눈 감김 판정
   ========================================================= */

// ===== 전역 상태 =====
const App = {
  state: "consent", // consent | calibration | menu | detection | alarm
  baselineEAR: null,
  threshold: null,
  selectedMember: null,
  paused: false,
  eyeClosedStart: null, // 눈 감김 시작 시각(ms)
  faceDetected: false,
  latestEAR: null,
  latestLandmarks: null,
};

// "눈 감김" 기준: 캘리브레이션 평균 EAR 의 몇 % 이하인지
const CLOSE_RATIO = 0.75;

// ===== 멤버 정보 =====
const MEMBERS = [
  { id: "hayoung", name: "송하영" },
  { id: "jiwon", name: "박지원" },
  { id: "chaeyoung", name: "이채영" },
  { id: "nagyeong", name: "이나경" },
  { id: "jiheon", name: "백지헌" },
];

// ===== EAR 계산용 랜드마크 (6점) =====
// 순서: [좌측끝, 윗점1, 윗점2, 우측끝, 아랫점2, 아랫점1]
const RIGHT_EYE_EAR = [33, 160, 158, 133, 153, 144];
const LEFT_EYE_EAR = [362, 385, 387, 263, 373, 380];

// ===== 눈 박스(bounding box)용 외곽 랜드마크 =====
const RIGHT_EYE_BOX = [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7];
const LEFT_EYE_BOX = [362, 398, 384, 385, 386, 387, 388, 466, 263, 249, 390, 373, 374, 380, 381, 382];

// ===== DOM =====
const cameraContainer = document.getElementById("cameraContainer");
const sourceVideo = document.getElementById("sourceVideo");
const overlay = document.getElementById("overlay");
const overlayCtx = overlay.getContext("2d");

const calibCountEl = document.getElementById("calibCount");
const consentError = document.getElementById("consentError");
const consentBtn = document.getElementById("consentBtn");
const memberGrid = document.getElementById("memberGrid");
const warningSubtitle = document.getElementById("warningSubtitle");
const countdownNumber = document.getElementById("countdownNumber");
const pausedBanner = document.getElementById("pausedBanner");
const ignoreBtn = document.getElementById("ignoreBtn");
const alarmVideo = document.getElementById("alarmVideo");
const alarmPlayBtn = document.getElementById("alarmPlayBtn");
const soundHint = document.getElementById("soundHint");

const screens = {
  consent: document.getElementById("screen-consent"),
  calibration: document.getElementById("screen-calibration"),
  menu: document.getElementById("screen-menu"),
  detection: document.getElementById("screen-detection"),
  alarm: document.getElementById("screen-alarm"),
};

// ===== 유틸 =====
function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// EAR = (수직거리 합) / (2 * 수평거리)
// 정규화 좌표를 실제 픽셀 비율로 보정해서 계산 (가로 4 : 세로 3 왜곡 보정)
function eyeAspectRatio(lm, idx) {
  const W = overlay.width || 640;
  const H = overlay.height || 480;
  const p = idx.map((i) => ({ x: lm[i].x * W, y: lm[i].y * H }));
  const vertical = dist(p[1], p[5]) + dist(p[2], p[4]);
  const horizontal = 2 * dist(p[0], p[3]);
  return horizontal === 0 ? 0 : vertical / horizontal;
}

// ===== 화면 전환 =====
function showScreen(name) {
  App.state = name;
  Object.entries(screens).forEach(([key, el]) => {
    el.classList.toggle("active", key === name);
  });
}

function placeCamera(slotId) {
  const slot = document.getElementById(slotId);
  if (slot && cameraContainer.parentElement !== slot) {
    slot.appendChild(cameraContainer);
  }
}

// ===== 화면 꺼짐 방지 (Wake Lock) =====
// 자동잠금으로 화면이 꺼지면 감지·알람이 멈추므로, 화면을 계속 켜둠
let wakeLock = null;
async function requestWakeLock() {
  if (!("wakeLock" in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch (err) {
    console.warn("화면 켜짐 유지 실패:", err);
  }
}

// =========================================================
// 1단계: 캘리브레이션 (시선 보정)
// =========================================================
let calibStart = null;
let calibSamples = [];

function startCalibration() {
  calibStart = null;
  calibSamples = [];
  calibCountEl.textContent = "3";
  placeCamera("calibCameraSlot");
  showScreen("calibration");
}

function handleCalibration() {
  if (App.faceDetected && App.latestEAR != null) {
    if (calibStart === null) calibStart = performance.now();
    calibSamples.push(App.latestEAR);

    const elapsed = performance.now() - calibStart;
    const remain = Math.max(Math.ceil((3000 - elapsed) / 1000), 0);
    calibCountEl.textContent = String(remain);

    if (elapsed >= 3000 && calibSamples.length > 5) {
      finishCalibration();
    }
  } else {
    // 얼굴이 사라지면 3초를 처음부터 다시 측정
    calibStart = null;
    calibSamples = [];
    calibCountEl.textContent = "3";
  }
}

function finishCalibration() {
  const avg = calibSamples.reduce((a, b) => a + b, 0) / calibSamples.length;
  App.baselineEAR = avg;
  App.threshold = avg * CLOSE_RATIO; // 기준값의 75% 이하를 "눈 감김"으로 판정
  calibStart = null;
  calibSamples = [];
  goToMenu();
}

// =========================================================
// 2단계: 멤버 선택
// =========================================================
function buildMemberCards() {
  memberGrid.innerHTML = "";
  MEMBERS.forEach((member) => {
    const card = document.createElement("button");
    card.className = "member-card";

    const avatar = document.createElement("span");
    avatar.className = "member-avatar";

    const img = document.createElement("img");
    img.src = `images/${member.id}.jpg`;
    img.alt = member.name;
    // 사진이 없으면 이름 첫 글자로 대체
    img.addEventListener("error", () => {
      avatar.textContent = member.name.charAt(0);
    });
    avatar.appendChild(img);

    const name = document.createElement("span");
    name.className = "member-name";
    name.textContent = member.name;

    card.appendChild(avatar);
    card.appendChild(name);
    card.addEventListener("click", () => selectMember(member));
    memberGrid.appendChild(card);
  });
}

function goToMenu() {
  resetDetectionTimers();
  showScreen("menu");
}

function selectMember(member) {
  App.selectedMember = member;
  // 사용자 클릭(제스처) 중에 영상을 미리 "잠금 해제" → 나중에 타이머로 자동재생 가능
  primeAlarmVideo(member);
  startDetection();
}

// 영상을 음소거로 잠깐 재생했다 멈춰서, 이후 자동재생 차단을 회피 + 미리 버퍼링
function primeAlarmVideo(member) {
  const src = `videos/${member.id}.mp4`;
  if (alarmVideo.getAttribute("src") !== src) {
    alarmVideo.src = src;
  }
  alarmVideo.muted = true;
  const p = alarmVideo.play();
  if (p && p.then) {
    p
      .then(() => {
        // 이미 알람이 시작됐다면 절대 멈추지 않음 (재생 중 영상 정지 방지)
        if (App.state === "alarm") {
          alarmVideo.muted = false;
          return;
        }
        // 잠금 해제용으로만 잠깐 재생하고 즉시 정지한다.
        // 음소거는 그대로 유지(muted) → 감지 화면에서 iOS가 이 영상을
        // 임의로 재생해도 소리가 새어나오지 않음.
        // 실제 알람 때 playAlarmVideo()에서 muted=false 로 소리를 켠다.
        alarmVideo.pause();
        alarmVideo.currentTime = 0;
      })
      .catch(() => {
        /* 자동재생 차단: 음소거 상태 그대로 둔다 */
      });
  }
}

// =========================================================
// 3단계: 메인 감지
// =========================================================
function startDetection() {
  resetDetectionTimers();
  App.paused = false;
  updatePauseUI();
  placeCamera("detectCameraSlot");
  showScreen("detection");

  // iOS 대비: 직전에 알람 영상이 재생되면서 카메라(sourceVideo)가
  // 멈춰버리는 경우가 있어, 감지 화면에 들어올 때 카메라를 다시 재생시킨다.
  // (카메라가 멈추면 얼굴 인식 루프가 멎어 타이머가 동작하지 않음)
  if (sourceVideo.srcObject) {
    sourceVideo.play().catch(() => {});
  }
}

function resetDetectionTimers() {
  App.eyeClosedStart = null;
  hideWarning();
}

function handleDetection() {
  drawOverlay();

  if (App.paused) return;

  // 눈 감김 = 얼굴 미인식 OR EAR 이 기준값 이하
  const eyesClosed =
    !App.faceDetected ||
    App.threshold == null ||
    (App.latestEAR != null && App.latestEAR <= App.threshold);

  const now = performance.now();

  if (eyesClosed) {
    if (App.eyeClosedStart === null) App.eyeClosedStart = now;
    const elapsed = now - App.eyeClosedStart;

    if (elapsed >= 6000) {
      // 총 6초 경과 (1초 대기 + 5초 카운트다운) → 알람
      goToAlarm();
    } else if (elapsed > 1000) {
      // 1초 초과 → 자막 + 카운트다운(5..1)
      const cd = Math.ceil((6000 - elapsed) / 1000);
      showWarning(cd);
    } else {
      // 0~1초 → 빨간 박스만 (깜빡임 무시용 대기)
      hideWarning();
    }
  } else {
    // 눈이 정상 인식 → 초기화
    App.eyeClosedStart = null;
    hideWarning();
  }
}

function showWarning(count) {
  warningSubtitle.hidden = false;
  countdownNumber.hidden = false;
  countdownNumber.textContent = String(count);
}

function hideWarning() {
  warningSubtitle.hidden = true;
  countdownNumber.hidden = true;
}

// 눈 박스 그리기
function drawOverlay() {
  overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  if (!App.faceDetected || !App.latestLandmarks) return;

  const closed =
    App.latestEAR != null &&
    App.threshold != null &&
    App.latestEAR <= App.threshold &&
    !App.paused;
  const color = closed ? "#ff3b30" : "#34c759";

  drawEyeBox(App.latestLandmarks, RIGHT_EYE_BOX, color);
  drawEyeBox(App.latestLandmarks, LEFT_EYE_BOX, color);
}

function drawEyeBox(lm, idx, color) {
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const i of idx) {
    const p = lm[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  const pad = 0.012;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;

  const x = minX * overlay.width;
  const y = minY * overlay.height;
  const w = (maxX - minX) * overlay.width;
  const h = (maxY - minY) * overlay.height;

  overlayCtx.strokeStyle = color;
  overlayCtx.lineWidth = 3;
  overlayCtx.strokeRect(x, y, w, h);
}

// "눈을 뜨고 있는데 인식이 안돼요" / "감지 재시작"
function togglePause() {
  App.paused = !App.paused;
  App.eyeClosedStart = null;
  hideWarning();
  updatePauseUI();
}

function updatePauseUI() {
  pausedBanner.hidden = !App.paused;
  ignoreBtn.textContent = App.paused
    ? "감지 재시작"
    : "눈을 뜨고 있는데 인식이 안돼요";
}

// =========================================================
// 4단계: 알람 재생
// =========================================================
const ALARM_MAX_PLAYS = 3; // 해제 안 하면 최대 3회 반복
let alarmPlayCount = 0;
let dismissing = false; // 알람 해제 중에는 pause 핸들러 무시

function goToAlarm() {
  resetDetectionTimers();
  showScreen("alarm");
  alarmPlayBtn.hidden = true;
  soundHint.hidden = true;
  if (App.selectedMember) {
    alarmPlayCount = 1;
    const src = `videos/${App.selectedMember.id}.mp4`;
    if (alarmVideo.getAttribute("src") !== src) alarmVideo.src = src;
    alarmVideo.currentTime = 0;
    playAlarmVideo();
  }
}

// 알람 영상 재생.
// 1) 소리까지 자동재생을 시도하고,
// 2) 막히면(무음모드/iOS 등) 음소거로라도 영상을 자동으로 띄워 시각 알람 보장,
// 3) 음소거 재생까지 막히면(드묾) 재생 버튼 노출.
function playAlarmVideo() {
  alarmVideo.muted = false;
  const p = alarmVideo.play();
  if (p && p.then) {
    p
      .then(() => {
        // 소리까지 정상 자동재생됨
        alarmPlayBtn.hidden = true;
        soundHint.hidden = true;
      })
      .catch(() => {
        // 소리 있는 자동재생 차단 → 음소거로라도 영상은 자동 재생
        alarmVideo.muted = true;
        alarmVideo
          .play()
          .then(() => {
            soundHint.hidden = false; // "탭하면 소리가 켜집니다"
            alarmPlayBtn.hidden = true;
          })
          .catch((err) => {
            console.warn("알람 영상 자동재생 완전 차단됨:", err);
            alarmPlayBtn.hidden = false; // 최후 수단: 직접 재생 버튼
          });
      });
  }
}

// 사용자가 탭해서 소리를 켜는 동작 (음소거 자동재생 상태에서)
function enableAlarmSound() {
  alarmVideo.muted = false;
  alarmVideo.play().catch(() => {});
  alarmPlayBtn.hidden = true;
  soundHint.hidden = true;
}

function dismissAlarm() {
  dismissing = true;
  alarmVideo.pause();
  alarmVideo.removeAttribute("src");
  alarmVideo.load();
  alarmPlayBtn.hidden = true;
  soundHint.hidden = true;
  App.selectedMember = null;
  App.paused = false;
  // 멤버 선택 메뉴(2단계)로 복귀 (시선 보정값은 그대로 유지)
  goToMenu();
  dismissing = false;
}

// =========================================================
// MediaPipe 콜백
// =========================================================
function onResults(results) {
  const lm =
    results.multiFaceLandmarks && results.multiFaceLandmarks.length > 0
      ? results.multiFaceLandmarks[0]
      : null;

  if (lm) {
    App.faceDetected = true;
    App.latestLandmarks = lm;
    const earR = eyeAspectRatio(lm, RIGHT_EYE_EAR);
    const earL = eyeAspectRatio(lm, LEFT_EYE_EAR);
    App.latestEAR = (earR + earL) / 2;
  } else {
    App.faceDetected = false;
    App.latestLandmarks = null;
    App.latestEAR = null;
  }

  if (App.state === "calibration") {
    handleCalibration();
  } else if (App.state === "detection") {
    handleDetection();
  } else {
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
  }
}

// =========================================================
// 초기화
// =========================================================
function initEvents() {
  consentBtn.addEventListener("click", onConsent);
  document.getElementById("backToMenuBtn").addEventListener("click", goToMenu);
  document.getElementById("dismissBtn").addEventListener("click", dismissAlarm);
  document.getElementById("resumeBtn").addEventListener("click", togglePause);
  ignoreBtn.addEventListener("click", togglePause);

  // 해제하지 않으면 영상이 최대 3회까지 반복 재생
  // (현재 음소거 상태를 유지해서 반복 시 깜빡임/정지 방지)
  alarmVideo.addEventListener("ended", () => {
    if (alarmPlayCount < ALARM_MAX_PLAYS) {
      alarmPlayCount++;
      alarmVideo.currentTime = 0;
      alarmVideo.play().catch(() => {});
    }
  });

  // 영상 영역(버튼·안내 포함)을 탭하면 소리 켜기
  // 버튼/안내는 wrap 안에 있어 클릭이 버블링되므로 핸들러는 하나면 충분
  document
    .querySelector(".alarm-video-wrap")
    .addEventListener("click", enableAlarmSound);

  // 재생 도중 예기치 않게 멈추면(무음모드에서 iOS가 소리 영상을 정지시키는 경우 등)
  // → 버튼을 띄우지 않고 "음소거로라도 계속 재생"해서 영상이 멈추지 않게 함
  alarmVideo.addEventListener("pause", () => {
    if (dismissing || App.state !== "alarm" || alarmVideo.ended) return;
    alarmVideo.muted = true;
    alarmVideo
      .play()
      .then(() => {
        soundHint.hidden = false; // "탭하면 소리가 켜집니다"
        alarmPlayBtn.hidden = true;
      })
      .catch(() => {
        // 음소거 재생까지 막히는 드문 경우에만 버튼 노출
        alarmPlayBtn.hidden = false;
      });
  });

  sourceVideo.addEventListener("loadedmetadata", () => {
    overlay.width = sourceVideo.videoWidth || 640;
    overlay.height = sourceVideo.videoHeight || 480;
  });

  // 탭이 다시 보이면 화면 켜짐 유지 재요청 (자동 해제 대응)
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && wakeLock === null) {
      requestWakeLock();
    }
  });
}

// 오류 메시지를 동의 화면에 그대로 보여줌 (원인 진단용)
function showCamError(msg) {
  consentError.textContent = msg;
  consentError.hidden = false;
}

async function initCamera() {
  // 1) 보안 컨텍스트 / API 확인
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    showCamError(
      "이 환경에서는 카메라를 사용할 수 없습니다. " +
        "https 주소로 접속했는지, 인앱 브라우저(카카오톡 등)가 아닌 " +
        "크롬/삼성인터넷에서 직접 열었는지 확인해 주세요."
    );
    return false;
  }

  // 2) 카메라 권한 요청 (사용자 탭 직후 호출 → 권한창 표시)
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user" },
      audio: false,
    });
  } catch (err) {
    const name = err && err.name ? err.name : String(err);
    showCamError("카메라를 시작할 수 없습니다: " + name);
    return false;
  }

  // 3) 영상 연결 후 재생
  sourceVideo.srcObject = stream;
  try {
    await sourceVideo.play();
  } catch (e) {
    /* autoplay/muted 속성으로 보통 자동 재생됨 */
  }

  // 4) 얼굴 인식 모듈 준비
  if (typeof FaceMesh === "undefined") {
    showCamError(
      "얼굴 인식 모듈을 불러오지 못했습니다. " +
        "네트워크 연결을 확인한 뒤 버튼을 다시 눌러 주세요."
    );
    return false;
  }

  const faceMesh = new FaceMesh({
    locateFile: (file) =>
      `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`,
  });
  faceMesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
  faceMesh.onResults(onResults);

  // 5) 프레임 루프 (직접 requestAnimationFrame 으로 구동)
  const pump = async () => {
    if (!sourceVideo.paused && sourceVideo.readyState >= 2) {
      try {
        await faceMesh.send({ image: sourceVideo });
      } catch (e) {
        /* 일시적 오류 무시 */
      }
    }
    requestAnimationFrame(pump);
  };
  requestAnimationFrame(pump);

  consentError.hidden = true;
  return true;
}

// "동의합니다" 탭 시점에 카메라 권한 요청 (모바일은 사용자 제스처가 있어야 권한창이 뜸)
let cameraStarted = false;
async function onConsent() {
  requestWakeLock(); // 제스처 안에서 화면 켜짐 유지 요청

  if (cameraStarted) {
    startCalibration();
    return;
  }

  consentBtn.disabled = true;
  consentBtn.textContent = "카메라 준비 중…";
  consentError.hidden = true;

  // 영상 요소를 먼저 보이게 한 뒤 카메라 시작 (모바일은 숨겨진 video 재생이 막힘)
  startCalibration();
  const ok = await initCamera();

  consentBtn.disabled = false;
  consentBtn.textContent = "위 내용을 숙지했으며, 영상 촬영에 동의합니다";

  if (ok) {
    cameraStarted = true;
  } else {
    showScreen("consent"); // 권한 거부/오류 시 동의 화면으로 복귀
    consentError.hidden = false;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  buildMemberCards();
  initEvents();
  showScreen("consent"); // 동의 화면부터 시작 (카메라는 동의 탭 시 시작)
});
