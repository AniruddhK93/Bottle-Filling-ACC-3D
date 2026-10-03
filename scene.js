/*
  ACC PLC interface used here:
    Channel: acc-plc-link
    Simulator -> Scene message name: plc-state
    Scene -> Simulator message name: scene-inputs

  The current ACC public scene help confirms the channel and message types,
  and that X inputs travel Scene -> Simulator while Y outputs travel
  Simulator -> Scene. The exact custom-scene registry/packaging is handled
  separately in ACC's acc-scenes.js.
*/

if (!window.THREE) {\n  document.body.insertAdjacentHTML("afterbegin", "<div style=\"padding:12px;background:#4a1f1f;color:#fff;font-family:Arial\">Three.js could not be loaded. Check the internet connection/CDN access.</div>");\n  throw new Error("Three.js library did not load.");\n}\n\nconst ACC_CHANNEL = "acc-plc-link";
const accChannel = "BroadcastChannel" in window ? new BroadcastChannel(ACC_CHANNEL) : null;

// -----------------------------------------------------------------------------
// MACHINE I/O
// -----------------------------------------------------------------------------

const outputs = {
  Y1: false, // Conveyor
  Y2: false  // Filling valve
};

const inputs = {
  X1: false, // Start PB
  X2: true,  // Stop PB, N.C. -> true at rest
  X3: false, // Bottle at filling station
  X4: false  // Fill complete
};

let simulatorLinked = false;
let simulatorRunning = false;

let standaloneRunning = false;
let simulationTime = 0;
let fillElapsed = 0;

let nextBottleId = 0;
let bottles = [];

const MACHINE = {
  beltSpeed: 1.55,
  stationX: 0.4,
  sensorX: 0.4,
  bottleStartX: -6.8,
  bottleExitX: 7.0,
  fillTime: 5.0,
  bottleSpacing: 2.5
};

const ui = {
  modeBadge: document.getElementById("modeBadge"),
  simBadge: document.getElementById("simBadge"),
  stateText: document.getElementById("stateText"),
  fillTime: document.getElementById("fillTime"),
  x3Text: document.getElementById("x3Text"),
  y1Led: document.getElementById("y1Led"),
  y2Led: document.getElementById("y2Led"),
  x1Led: document.getElementById("x1Led"),
  x2Led: document.getElementById("x2Led"),
  x3Led: document.getElementById("x3Led"),
  x4Led: document.getElementById("x4Led"),
  eventLog: document.getElementById("eventLog"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  resetBtn: document.getElementById("resetBtn")
};

// -----------------------------------------------------------------------------
// THREE.JS SCENE
// -----------------------------------------------------------------------------

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ antialias: true });
} catch (error) {
  document.getElementById("sceneCanvas").innerHTML =
    '<div style="padding:30px;color:#ffb4b4;font-family:Arial">' +
    '<h2>3D/WebGL could not start</h2>' +
    '<p>' + String(error) + '</p></div>';
  throw error;
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(10, 10);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;

document.getElementById("sceneCanvas").appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1015);
scene.fog = new THREE.Fog(0x0b1015, 16, 30);

const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
camera.position.set(10, 8, 11);

const controls = {
  update() {}
};
camera.lookAt(new THREE.Vector3(0, 0.9, 0));

scene.add(new THREE.HemisphereLight(0xb8d7ff, 0x20252a, 2.0));

const keyLight = new THREE.DirectionalLight(0xffffff, 3.0);
keyLight.position.set(6, 10, 7);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
scene.add(keyLight);

const fillLight = new THREE.PointLight(0x8cc8ff, 70, 16);
fillLight.position.set(0, 5, 2);
scene.add(fillLight);

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function addBox({ w, h, d, x = 0, y = 0, z = 0, color = 0xffffff, metalness = 0.1, roughness = 0.65 }) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(w, h, d),
    new THREE.MeshStandardMaterial({ color, metalness, roughness })
  );
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

function addCylinder({ r, h, x = 0, y = 0, z = 0, color = 0xffffff, metalness = 0.05, roughness = 0.55, radial = 32 }) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(r, r, h, radial),
    new THREE.MeshStandardMaterial({ color, metalness, roughness })
  );
  mesh.position.set(x, y + h / 2, z);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  scene.add(mesh);
  return mesh;
}

// -----------------------------------------------------------------------------
// FLOOR / CONVEYOR
// -----------------------------------------------------------------------------

addBox({ w: 19, h: 0.25, d: 9, x: 0, y: -0.25, z: 0, color: 0x252d35, roughness: 0.9 });

const belt = addBox({
  w: 15,
  h: 0.18,
  d: 3.0,
  x: 0.1,
  y: 0.5,
  z: 0,
  color: 0x151a20,
  metalness: 0.2,
  roughness: 0.55
});

const rollerMeshes = [];
for (let x = -7.2; x <= 7.2; x += 0.8) {
  const roller = new THREE.Mesh(
    new THREE.CylinderGeometry(0.12, 0.12, 3.2, 24),
    new THREE.MeshStandardMaterial({ color: 0x707780, metalness: 0.85, roughness: 0.3 })
  );
  roller.rotation.z = Math.PI / 2;
  roller.position.set(x, 0.58, 0);
  roller.castShadow = true;
  roller.receiveShadow = true;
  scene.add(roller);
  rollerMeshes.push(roller);
}

// Side rails
addBox({ w: 15, h: 0.18, d: 0.14, x: 0.1, y: 1.42, z: -1.45, color: 0x5a646e, metalness: 0.8, roughness: 0.25 });
addBox({ w: 15, h: 0.18, d: 0.14, x: 0.1, y: 1.42, z: 1.45, color: 0x5a646e, metalness: 0.8, roughness: 0.25 });

// -----------------------------------------------------------------------------
// FILLING STATION
// -----------------------------------------------------------------------------

// Main frame
addBox({ w: 2.8, h: 3.8, d: 2.7, x: 0.4, y: 1.0, z: 0, color: 0x3c464f, metalness: 0.65, roughness: 0.35 });
addBox({ w: 2.2, h: 2.9, d: 2.35, x: 0.4, y: 1.45, z: 0, color: 0x20272e, metalness: 0.2, roughness: 0.6 });

// Transparent front window
const windowMat = new THREE.MeshPhysicalMaterial({
  color: 0x7da8bd,
  transparent: true,
  opacity: 0.18,
  roughness: 0.1,
  metalness: 0.1
});

const guard = new THREE.Mesh(new THREE.BoxGeometry(2.2, 2.7, 0.05), windowMat);
guard.position.set(0.4, 3.0, 1.2);
scene.add(guard);

// Top tank
const tank = new THREE.Mesh(
  new THREE.CylinderGeometry(0.55, 0.55, 1.25, 32),
  new THREE.MeshStandardMaterial({
    color: 0x9aa6af,
    transparent: true,
    opacity: 0.58,
    metalness: 0.6,
    roughness: 0.25
  })
);
tank.position.set(0.4, 4.55, 0);
tank.castShadow = true;
scene.add(tank);

// Tank liquid
const liquid = new THREE.Mesh(
  new THREE.CylinderGeometry(0.48, 0.48, 0.82, 32),
  new THREE.MeshStandardMaterial({ color: 0x63b8d9, transparent: true, opacity: 0.75 })
);
liquid.position.set(0.4, 4.35, 0);
scene.add(liquid);

// Nozzle
const nozzleGroup = new THREE.Group();
nozzleGroup.position.set(0.4, 3.55, 0);
scene.add(nozzleGroup);

const nozzleBody = addCylinder({
  r: 0.12,
  h: 0.65,
  x: 0.4,
  y: 3.0,
  z: 0,
  color: 0xd4bd66,
  metalness: 0.85,
  roughness: 0.22,
  radial: 24
});
nozzleGroup.add(nozzleBody);
scene.remove(nozzleBody);

const nozzleBodyLocal = new THREE.Mesh(
  new THREE.CylinderGeometry(0.12, 0.12, 0.65, 24),
  new THREE.MeshStandardMaterial({ color: 0xd4bd66, metalness: 0.85, roughness: 0.22 })
);
nozzleBodyLocal.position.y = -0.3;
nozzleBodyLocal.castShadow = true;
nozzleGroup.add(nozzleBodyLocal);

const stream = new THREE.Mesh(
  new THREE.CylinderGeometry(0.045, 0.045, 1.45, 16),
  new THREE.MeshStandardMaterial({
    color: 0x6fd5ff,
    transparent: true,
    opacity: 0.88,
    emissive: 0x174b67
  })
);
stream.position.set(0, -1.0, 0);
stream.visible = false;
nozzleGroup.add(stream);

// Photoeye sensor
const sensorHousing = addBox({
  w: 0.18,
  h: 0.8,
  d: 0.35,
  x: MACHINE.sensorX,
  y: 1.0,
  z: -1.95,
  color: 0x27323b,
  metalness: 0.4,
  roughness: 0.35
});

const sensorLens = new THREE.Mesh(
  new THREE.CylinderGeometry(0.09, 0.09, 0.05, 24),
  new THREE.MeshStandardMaterial({ color: 0x2e667c, emissive: 0x0a2631 })
);
sensorLens.rotation.x = Math.PI / 2;
sensorLens.position.set(MACHINE.sensorX, 1.25, -2.13);
scene.add(sensorLens);

// Sensor beam
const beam = new THREE.Mesh(
  new THREE.CylinderGeometry(0.025, 0.025, 3.0, 12),
  new THREE.MeshBasicMaterial({ color: 0x55c8ff, transparent: true, opacity: 0.22 })
);
beam.rotation.x = Math.PI / 2;
beam.position.set(MACHINE.sensorX, 1.25, -0.45);
scene.add(beam);

// Control cabinet
addBox({ w: 1.5, h: 2.5, d: 0.6, x: 4.7, y: 0.5, z: -2.3, color: 0x3d464f, metalness: 0.55, roughness: 0.4 });
addBox({ w: 1.2, h: 0.95, d: 0.08, x: 4.7, y: 1.7, z: -1.98, color: 0x101419, roughness: 0.7 });

// -----------------------------------------------------------------------------
// BOTTLES
// -----------------------------------------------------------------------------

function createBottle(id) {
  const group = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CylinderGeometry(0.34, 0.38, 1.15, 32),
    new THREE.MeshStandardMaterial({
      color: 0xdce3e7,
      transparent: true,
      opacity: 0.78,
      metalness: 0.05,
      roughness: 0.18
    })
  );
  body.position.y = 0.62;
  body.castShadow = true;
  group.add(body);

  const neck = new THREE.Mesh(
    new THREE.CylinderGeometry(0.18, 0.18, 0.32, 24),
    new THREE.MeshStandardMaterial({ color: 0xdce3e7, transparent: true, opacity: 0.8 })
  );
  neck.position.y = 1.36;
  neck.castShadow = true;
  group.add(neck);

  const cap = new THREE.Mesh(
    new THREE.CylinderGeometry(0.2, 0.2, 0.12, 24),
    new THREE.MeshStandardMaterial({ color: 0x4c5964, metalness: 0.1, roughness: 0.4 })
  );
  cap.position.y = 1.58;
  cap.castShadow = true;
  group.add(cap);

  const liquidFill = new THREE.Mesh(
    new THREE.CylinderGeometry(0.31, 0.34, 0.82, 32),
    new THREE.MeshStandardMaterial({
      color: 0x4db4d3,
      transparent: true,
      opacity: 0.78
    })
  );
  liquidFill.position.y = 0.33;
  liquidFill.scale.y = 0.04;
  liquidFill.visible = false;
  group.add(liquidFill);

  group.userData = {
    id,
    filled: false,
    liquidFill
  };

  scene.add(group);
  return group;
}

function addBottle(startX = MACHINE.bottleStartX) {
  const bottle = createBottle(nextBottleId++);
  bottle.position.set(startX, 0.5, 0);
  bottles.push(bottle);
  return bottle;
}

function removeBottle(bottle) {
  scene.remove(bottle);
  bottles = bottles.filter((b) => b !== bottle);
}

// Create an initial line of bottles for the visual scene
for (let i = 0; i < 3; i++) {
  addBottle(MACHINE.bottleStartX - i * MACHINE.bottleSpacing);
}

// -----------------------------------------------------------------------------
// STATUS / LOGGING
// -----------------------------------------------------------------------------

function logEvent(message) {
  const now = new Date().toLocaleTimeString();
  const div = document.createElement("div");
  div.className = "log-entry";
  div.innerHTML = `<strong>${now}</strong> ${message}`;
  ui.eventLog.prepend(div);

  while (ui.eventLog.children.length > 20) {
    ui.eventLog.removeChild(ui.eventLog.lastChild);
  }
}

function setOutput(name, value) {
  outputs[name] = Boolean(value);

  if (name === "Y1") ui.y1Led.classList.toggle("on", outputs.Y1);
  if (name === "Y2") ui.y2Led.classList.toggle("on", outputs.Y2);

  update3DFromOutputs();
}

function setInput(name, value) {
  inputs[name] = Boolean(value);

  const led = {
    X1: ui.x1Led,
    X2: ui.x2Led,
    X3: ui.x3Led,
    X4: ui.x4Led
  }[name];

  if (led) led.classList.toggle("on", inputs[name]);

  ui.x3Text.textContent = inputs.X3 ? "ON" : "OFF";
}

function update3DFromOutputs() {
  stream.visible = Boolean(outputs.Y2);
  sensorLens.material.emissive.setHex(inputs.X3 ? 0x1a839e : 0x0a2631);
}

function updateUI() {
  const linked = simulatorLinked;
  ui.modeBadge.textContent = linked ? "SIM LINKED" : "STANDALONE";
  ui.modeBadge.className = `badge ${linked ? "sim" : "standalone"}`;
  ui.simBadge.textContent = linked
    ? `SIMULATOR ${simulatorRunning ? "RUNNING" : "STOPPED"}`
    : "NO SIMULATOR";
  ui.simBadge.className = `badge ${linked ? "sim" : "neutral"}`;

  if (linked) {
    ui.stateText.textContent = simulatorRunning ? "PLC CONTROLLED" : "WAITING FOR RUN";
  } else {
    ui.stateText.textContent = standaloneRunning ? "STANDALONE RUNNING" : "STOPPED";
  }

  ui.fillTime.textContent = fillElapsed.toFixed(1);
}

// -----------------------------------------------------------------------------
// MACHINE PHYSICS / SEQUENCE
// -----------------------------------------------------------------------------

function getStationBottle() {
  return bottles.find(
    (bottle) =>
      Math.abs(bottle.position.x - MACHINE.stationX) < 0.28
  ) || null;
}

function calculateStationSensor() {
  const bottle = getStationBottle();
  return Boolean(bottle);
}

function updateSensorStates() {
  // In simulator-linked mode, X inputs are authored by this scene.
  // X1 and X2 are operator inputs; X3/X4 are automatic sensors.
  const newX3 = calculateStationSensor();

  if (newX3 !== inputs.X3) {
    setInput("X3", newX3);
    logEvent(newX3 ? "Bottle detected at filling station — X3 ON" : "Bottle left sensor — X3 OFF");
  }

  const newX4 = fillElapsed >= MACHINE.fillTime;
  if (newX4 !== inputs.X4) {
    setInput("X4", newX4);
    if (newX4) logEvent("Fill complete — X4 ON");
  }
}

function applyFillingProgress(dt) {
  const stationBottle = getStationBottle();

  if (outputs.Y2 && stationBottle) {
    fillElapsed += dt;
    stationBottle.userData.filled = Math.min(fillElapsed / MACHINE.fillTime, 1);
    stationBottle.userData.liquidFill.visible = true;
    stationBottle.userData.liquidFill.scale.y = Math.max(0.04, stationBottle.userData.filled);
  }

  if (!outputs.Y2) {
    fillElapsed = 0;
    setInput("X4", false);

    for (const bottle of bottles) {
      if (!bottle.userData.filled) {
        bottle.userData.liquidFill.visible = false;
        bottle.userData.liquidFill.scale.y = 0.04;
      }
    }
  }

  if (stationBottle && fillElapsed >= MACHINE.fillTime) {
    stationBottle.userData.filled = true;
  }
}

function moveBottles(dt) {
  if (!outputs.Y1) return;

  const stationBottle = getStationBottle();

  for (const bottle of bottles) {
    // Do not let a bottle pass through the filling station while the valve is on.
    if (outputs.Y2 && stationBottle === bottle) {
      continue;
    }

    // Also stop the bottle when it reaches the station, waiting for the PLC's filling command.
    if (!outputs.Y2 && Math.abs((bottle.position.x + MACHINE.beltSpeed * dt) - MACHINE.stationX) < 0.12) {
      continue;
    }

    bottle.position.x += MACHINE.beltSpeed * dt;
  }

  const lastBottle = bottles[bottles.length - 1];
  if (lastBottle && lastBottle.position.x > MACHINE.bottleStartX + 2.8) {
    addBottle(MACHINE.bottleStartX - 2.5);
  }

  for (const bottle of [...bottles]) {
    if (bottle.position.x > MACHINE.bottleExitX) {
      logEvent(`Bottle #${bottle.userData.id + 1} exited conveyor`);
      removeBottle(bottle);
    }
  }
}

function updateStandaloneSequence(dt) {
  if (!standaloneRunning) return;

  // In standalone mode the scene acts as a demonstration of the intended process.
  const stationBottle = getStationBottle();

  if (!stationBottle) {
    setOutput("Y1", true);
    setOutput("Y2", false);
  } else if (!stationBottle.userData.filled) {
    setOutput("Y1", false);
    setOutput("Y2", true);
  } else {
    setOutput("Y2", false);
    setOutput("Y1", true);
  }

  moveBottles(dt);
  updateSensorStates();
  applyFillingProgress(dt);
}

function updateSimulation(dt) {
  if (simulatorLinked) {
    // The ladder program is the authority over Y1/Y2.
    moveBottles(dt);
    updateSensorStates();
    applyFillingProgress(dt);
  } else {
    updateStandaloneSequence(dt);
  }
}

// -----------------------------------------------------------------------------
// ACC BROADCASTCHANNEL LINK
// -----------------------------------------------------------------------------

function boolFrom(value) {
  return Boolean(value);
}

function parseOutputMap(message) {
  /*
    The ACC public help documents `plc-state` and Y outputs but does not expose
    the full custom scene object schema in its HTML help. This parser accepts
    common map shapes so the scene remains easy to adapt to the current guide.
  */

  if (!message || typeof message !== "object") return null;

  const candidate =
    message.outputs ??
    message.y ??
    message.Y ??
    message.state?.outputs ??
    message.plc?.outputs ??
    null;

  if (!candidate || typeof candidate !== "object") return null;

  return {
    Y1: boolFrom(candidate.Y1 ?? candidate.y1 ?? candidate[1]),
    Y2: boolFrom(candidate.Y2 ?? candidate.y2 ?? candidate[2])
  };
}

function parseRunState(message) {
  if (!message || typeof message !== "object") return false;

  return boolFrom(
    message.running ??
    message.run ??
    message.runState ??
    message.state?.running ??
    false
  );
}

function broadcastSceneInputs() {
  if (!accChannel) return;

  // X1/X2 are operator values. X3/X4 are automatic sensor values.
  accChannel.postMessage({
    type: "scene-inputs",
    inputs: {
      X1: inputs.X1,
      X2: inputs.X2,
      X3: inputs.X3,
      X4: inputs.X4
    }
  });
}

if (accChannel) {
  accChannel.onmessage = (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;

    if (message.type === "ping") {
      simulatorLinked = true;
      updateUI();
      broadcastSceneInputs();
      return;
    }

    if (message.type === "plc-state") {
      simulatorLinked = true;

      const parsedOutputs = parseOutputMap(message);
      if (parsedOutputs) {
        setOutput("Y1", parsedOutputs.Y1);
        setOutput("Y2", parsedOutputs.Y2);
      }

      simulatorRunning = parseRunState(message);

      // Once linked, scene standalone sequence is disabled.
      standaloneRunning = false;

      updateUI();
      broadcastSceneInputs();
    }
  };
}

// Disconnect detector: ACC documents a 500ms heartbeat and automatic scene
// fallback after the heartbeats stop. We use a conservative timeout here.
let lastPingMs = performance.now();

setInterval(() => {
  const now = performance.now();

  if (simulatorLinked && now - lastPingMs > 2200) {
    simulatorLinked = false;
    simulatorRunning = false;
    standaloneRunning = false;

    setOutput("Y1", false);
    setOutput("Y2", false);
    setInput("X1", false);
    setInput("X2", true);
    setInput("X4", false);

    logEvent("ACC simulator link lost — returned to standalone mode");
    updateUI();
  }

  if (accChannel) {
    // Do not actively transmit a fake heartbeat. The simulator owns that side.
  }
}, 250);

if (accChannel) {
  // Ping messages are separately recognized so we can keep track of the link.
  const originalHandler = accChannel.onmessage;

  accChannel.onmessage = (event) => {
    const message = event.data;

    if (message?.type === "ping") {
      lastPingMs = performance.now();
    }

    originalHandler?.(event);
  };
}

// -----------------------------------------------------------------------------
// MANUAL CONTROLS
// -----------------------------------------------------------------------------

ui.startBtn.addEventListener("click", () => {
  if (simulatorLinked) {
    // In SIM LINKED mode operator inputs should normally be owned by the PLC
    // simulator. This button is intentionally disabled from changing X1.
    logEvent("START ignored locally while SIM LINKED; operate X1 in ACC.");
    return;
  }

  standaloneRunning = true;
  setInput("X1", true);
  logEvent("Standalone START pressed — X1 ON");

  setTimeout(() => {
    setInput("X1", false);
  }, 250);

  updateUI();
});

ui.stopBtn.addEventListener("click", () => {
  if (simulatorLinked) {
    logEvent("STOP ignored locally while SIM LINKED; operate X2 in ACC.");
    return;
  }

  standaloneRunning = false;
  setOutput("Y1", false);
  setOutput("Y2", false);
  setInput("X2", false);
  logEvent("Standalone STOP pressed — X2 opened");

  setTimeout(() => {
    setInput("X2", true);
  }, 400);

  updateUI();
});

ui.resetBtn.addEventListener("click", () => {
  standaloneRunning = false;
  simulatorLinked = false;
  simulatorRunning = false;

  setOutput("Y1", false);
  setOutput("Y2", false);

  setInput("X1", false);
  setInput("X2", true);
  setInput("X3", false);
  setInput("X4", false);

  fillElapsed = 0;

  for (const bottle of [...bottles]) {
    removeBottle(bottle);
  }

  for (let i = 0; i < 3; i++) {
    addBottle(MACHINE.bottleStartX - i * MACHINE.bottleSpacing);
  }

  logEvent("Scene reset");
  updateUI();
});

// -----------------------------------------------------------------------------
// KEYBOARD SHORTCUTS
// -----------------------------------------------------------------------------

window.addEventListener("keydown", (event) => {
  if (event.key.toLowerCase() === "r") {
    standaloneRunning = true;
    updateUI();
  }

  if (event.key.toLowerCase() === "s") {
    standaloneRunning = false;
    setOutput("Y1", false);
    setOutput("Y2", false);
    updateUI();
  }
});

// -----------------------------------------------------------------------------
// ANIMATION
// -----------------------------------------------------------------------------

let previousTime = performance.now();

function animate(now) {
  requestAnimationFrame(animate);

  const dt = Math.min((now - previousTime) / 1000, 0.05);
  previousTime = now;

  simulationTime += dt;

  // Conveyor rollers rotate when Y1 is energized.
  if (outputs.Y1) {
    for (const roller of rollerMeshes) {
      roller.rotation.x += dt * 8.0;
    }
  }

  // Filling animation
  if (outputs.Y2) {
    stream.visible = true;
    stream.scale.y = 0.94 + Math.sin(simulationTime * 18) * 0.05;
    nozzleBodyLocal.material.emissive = new THREE.Color(0x5a4b14);
    fillLight.intensity = 100;
  } else {
    stream.visible = false;
    fillLight.intensity = 45;
  }

  updateSimulation(dt);
  updateUI();
  controls.update();
  renderer.render(scene, camera);
}

function resize() {
  const container = document.getElementById("sceneContainer");
  const width = container.clientWidth;
  const height = container.clientHeight;

  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
}

window.addEventListener("resize", resize);

resize();
updateSensorStates();
updateUI();
logEvent("Scene ready — press START to run the standalone demonstration");
requestAnimationFrame(animate);