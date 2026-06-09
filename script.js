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
  startDetection();
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

function goToAlarm() {
  resetDetectionTimers();
  showScreen("alarm");
  if (App.selectedMember) {
    alarmPlayCount = 1;
    alarmVideo.src = `videos/${App.selectedMember.id}.mp4`;
    alarmVideo.currentTime = 0;
    alarmVideo.play().catch(() => {
      /* 자동재생 차단 시 사용자 상호작용 후 재생됨 */
    });
  }
}

function dismissAlarm() {
  alarmVideo.pause();
  alarmVideo.removeAttribute("src");
  alarmVideo.load();
  App.selectedMember = null;
  App.paused = false;
  // 멤버 선택 메뉴(2단계)로 복귀 (시선 보정값은 그대로 유지)
  goToMenu();
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
  consentBtn.addEventListener("click", startCalibration);
  document.getElementById("backToMenuBtn").addEventListener("click", goToMenu);
  document.getElementById("dismissBtn").addEventListener("click", dismissAlarm);
  document.getElementById("resumeBtn").addEventListener("click", togglePause);
  ignoreBtn.addEventListener("click", togglePause);

  // 해제하지 않으면 영상이 최대 3회까지 반복 재생
  alarmVideo.addEventListener("ended", () => {
    if (alarmPlayCount < ALARM_MAX_PLAYS) {
      alarmPlayCount++;
      alarmVideo.currentTime = 0;
      alarmVideo.play().catch(() => {});
    }
  });

  sourceVideo.addEventListener("loadedmetadata", () => {
    overlay.width = sourceVideo.videoWidth || 640;
    overlay.height = sourceVideo.videoHeight || 480;
  });
}

async function initCamera() {
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

  // Camera 유틸이 getUserMedia 를 호출 → 진입 시 자동으로 권한 요청
  const camera = new Camera(sourceVideo, {
    onFrame: async () => {
      await faceMesh.send({ image: sourceVideo });
    },
    width: 640,
    height: 480,
  });

  try {
    await camera.start();
    consentError.hidden = true;
  } catch (err) {
    console.error("카메라 시작 실패:", err);
    consentError.hidden = false;
  }
}

window.addEventListener("DOMContentLoaded", () => {
  buildMemberCards();
  initEvents();
  showScreen("consent"); // 동의 화면부터 시작
  initCamera(); // 권한은 진입 시 자동 요청
});
