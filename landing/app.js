const canvas = document.getElementById('signal-canvas');
const ctx = canvas.getContext('2d');

const colors = ['#0f766e', '#b42318', '#b7791f'];
let width = 0;
let height = 0;
let points = [];

function resize() {
  const ratio = window.devicePixelRatio || 1;
  width = canvas.clientWidth;
  height = canvas.clientHeight;
  canvas.width = Math.floor(width * ratio);
  canvas.height = Math.floor(height * ratio);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  points = [
    { x: width * 0.18, y: height * 0.28, color: colors[0] },
    { x: width * 0.52, y: height * 0.42, color: colors[1] },
    { x: width * 0.82, y: height * 0.68, color: colors[2] },
    { x: width * 0.38, y: height * 0.78, color: colors[0] },
  ];
}

function drawLine(a, b, progress, color) {
  const x = a.x + (b.x - a.x) * progress;
  const y = a.y + (b.y - a.y) * progress;
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(x, y);
  ctx.stroke();
}

function draw(time) {
  ctx.clearRect(0, 0, width, height);
  ctx.globalAlpha = 0.55;

  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    const progress = (Math.sin(time / 1100 + i) + 1) / 2;
    drawLine(current, next, progress, current.color);
  }

  points.forEach((point, index) => {
    const pulse = (Math.sin(time / 700 + index) + 1) / 2;
    ctx.fillStyle = point.color;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 4 + pulse * 3, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.globalAlpha = 1;
  requestAnimationFrame(draw);
}

resize();
window.addEventListener('resize', resize);
requestAnimationFrame(draw);
