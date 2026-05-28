class GrblController {
    constructor() {
        this.port = null;
        this.writer = null;
        this.reader = null;
        this.inputDone = null;
        this.outputDone = null;
        this.inputStream = null;
        this.outputStream = null;

        this.isConnected = false;
        this.isSending = false;
        this.txQueue = [];
        this.txTotal = 0;
        this.rxBuffer = "";

        this.onLog = (msg, type) => console.log(`[${type}] ${msg}`);
        this.onStatusChange = () => {};
        this.onProgress = () => {};
        this.onConnect = () => {};
        this.onDisconnect = () => {};
    }

    async connect() {
        if (!navigator.serial) {
        throw new Error("Web Serial API not supported in this browser.");
        }

        try {
        this.port = await navigator.serial.requestPort();
        await this.port.open({ baudRate: 115200 });

        const textEncoder = new TextEncoderStream();
        this.outputDone = textEncoder.readable.pipeTo(this.port.writable);
        this.inputStream = textEncoder.writable;
        this.writer = this.inputStream.getWriter();

        const textDecoder = new TextDecoderStream();
        this.inputDone = this.port.readable.pipeTo(textDecoder.writable);
        this.outputStream = textDecoder.readable;
        this.reader = this.outputStream.getReader();

        this.isConnected = true;
        this.onConnect();
        this.onLog("Port ouvert a 115200 bauds.", "info");

        this.sendRealtime("\r\n");
        this.readLoop();
        } catch (err) {
        this.onLog("Echec de connexion: " + err.message, "error");
        await this.disconnect();
        }
    }

    async disconnect() {
        try {
        if (this.reader) {
            await this.reader.cancel();
            if (this.inputDone) await this.inputDone.catch(() => {});
        }
        } catch (_) {}

        try {
        if (this.writer) {
            await this.writer.close();
            if (this.outputDone) await this.outputDone;
        }
        } catch (_) {}

        try {
        if (this.port) {
            await this.port.close();
        }
        } catch (_) {}

        this.reader = null;
        this.writer = null;
        this.inputDone = null;
        this.outputDone = null;
        this.port = null;
        this.isConnected = false;
        this.isSending = false;
        this.txQueue = [];
        this.onDisconnect();
        this.onLog("Deconnecte.", "info");
    }

    async readLoop() {
        while (this.port && this.port.readable && this.isConnected) {
        try {
            const { value, done } = await this.reader.read();
            if (done) break;
            if (value) this.handleData(value);
        } catch (err) {
            this.onLog("Erreur lecture: " + err.message, "error");
            break;
        }
        }
    }

    handleData(chunk) {
        this.rxBuffer += chunk;
        const lines = this.rxBuffer.split("\n");
        this.rxBuffer = lines.pop() || "";

        for (let line of lines) {
        line = line.trim();
        if (!line) continue;

        this.onLog(line, "rx");

        if (line === "ok") {
            if (this.isSending) this.sendNextLine();
            continue;
        }

        if (line.toLowerCase().startsWith("error")) {
            this.onLog("Erreur GRBL: " + line, "error");
            if (this.isSending) this.sendNextLine();
            continue;
        }

        if (line.startsWith("Grbl")) {
            this.onLog("GRBL detecte: " + line, "success");
        }
        }
    }

    async sendCommand(cmd) {
        if (!this.isConnected || !this.writer) return;
        this.onLog(cmd, "tx");
        try {
        await this.writer.write(cmd + "\n");
        } catch (err) {
        this.onLog("Erreur ecriture: " + err.message, "error");
        }
    }

    async sendRealtime(char) {
        if (!this.isConnected || !this.writer) return;
        try {
        await this.writer.write(char);
        } catch (_) {}
    }

    startStreaming(gcodeString) {
        if (!this.isConnected) {
        alert("Veuillez connecter le robot d'abord !");
        return;
        }

        this.txQueue = gcodeString
        .split("\n")
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith(";"));

        if (this.txQueue.length === 0) {
        alert("Le GCode est vide !");
        return;
        }

        this.txTotal = this.txQueue.length;
        this.isSending = true;
        this.onLog(`Demarrage de l'envoi (${this.txTotal} lignes)...`, "info");
        this.sendNextLine();
    }

    async sendNextLine() {
        if (!this.isSending) return;

        if (this.txQueue.length === 0) {
        this.isSending = false;
        this.onLog("--- Impression terminee ! ---", "success");
        this.onProgress(100);
        return;
        }

        const sent = this.txTotal - this.txQueue.length;
        const progress = Math.floor((sent / this.txTotal) * 100);
        this.onProgress(progress);

        const line = this.txQueue.shift();
        await this.sendCommand(line);
    }

    stopSending() {
        this.isSending = false;
        this.txQueue = [];
        this.onLog("Impression annulee.", "error");
        this.onProgress(0);
        this.sendRealtime("\x18");
        setTimeout(() => this.sendRealtime("\r\n"), 100);
    }

    softReset() {
        this.sendRealtime("\x18");
        this.onLog("Soft reset envoye.", "info");
    }

    unlock() {
        this.sendCommand("$X");
    }

    home() {
        this.sendCommand("$H");
    }

    async sendJog(cmd) {
        if (!this.isConnected || !this.writer) return
        try {
        await this.writer.write(cmd + "\n")
        } catch (_) {}
    }
}

const grbl = new GrblController();

const ui = {
    btnConnect: document.getElementById("btnConnect"),
    btnSend: document.getElementById("btnSend"),
    btnStop: document.getElementById("btnStop"),
    btnZero: document.getElementById("btnZero"),
    btnUnlock: document.getElementById("btnUnlock"),
    btnReset: document.getElementById("btnResetGrbl"),
    statusText: document.getElementById("serialStatus"),
    logDiv: document.getElementById("serialLog"),
    inputCmd: document.getElementById("consoleInput"),
    btnSendCmd: document.getElementById("btnConsoleSend"),
    btnClearLog: document.getElementById("btnClearLog"),
    btnConfSteps: document.getElementById("btnConfSteps"),
    btnConfSpeed: document.getElementById("btnConfSpeed"),
    btnConfArms: document.getElementById("btnConfArms"),
    btnStatus: document.getElementById("btnStatus")
};

document.addEventListener("DOMContentLoaded", () => {
    if (ui.btnConnect) {
        ui.btnConnect.addEventListener("click", () => {
        if (grbl.isConnected) grbl.disconnect();
        else grbl.connect();
        });
    }

    if (ui.btnSend) {
        ui.btnSend.addEventListener("click", () => {
        if (typeof getCurrentGcode !== "function") return;
        const gcode = getCurrentGcode();
        if (gcode) grbl.startStreaming(gcode);
        else alert("Generez d'abord un chemin (GCode) !");
        });
    }

    if (ui.btnStop) ui.btnStop.addEventListener("click", () => grbl.stopSending());
    if (ui.btnZero) ui.btnZero.addEventListener("click", () => grbl.sendCommand("G92 X0 Y0"));
    if (ui.btnUnlock) ui.btnUnlock.addEventListener("click", () => grbl.unlock());
    if (ui.btnReset) ui.btnReset.addEventListener("click", () => grbl.softReset());

    if (ui.btnSendCmd) ui.btnSendCmd.addEventListener("click", sendManual);
    if (ui.inputCmd) {
        ui.inputCmd.addEventListener("keypress", e => {
        if (e.key === "Enter") sendManual();
        });
    }

    if (ui.btnClearLog) {
        ui.btnClearLog.addEventListener("click", () => {
        ui.logDiv.innerHTML = "";
        });
    }

    setupConfigButtons();
});

function sendManual() {
    const txt = (ui.inputCmd?.value || "").trim();
    if (!txt) return;
    grbl.sendCommand(txt);
    ui.inputCmd.value = "";
}

function setupConfigButtons() {
    if (ui.btnStatus) ui.btnStatus.addEventListener("click", () => grbl.sendCommand("$$"));

    if (ui.btnConfSpeed) {
        ui.btnConfSpeed.addEventListener("click", () => {
        grbl.sendCommand("$110=500.0");
        grbl.sendCommand("$111=500.0");
        grbl.sendCommand("$120=20.0");
        grbl.sendCommand("$121=20.0");
        grbl.onLog(">> Safe speeds sent", "info");
        });
    }

    if (ui.btnConfArms) {
        ui.btnConfArms.addEventListener("click", () => {
        const l1 = prompt("Longueur Bras 1 (mm):", "150");
        const l2 = prompt("Longueur Bras 2 (mm):", "150");
        if (!l1 || !l2) return;
        grbl.sendCommand("$28=" + l1);
        grbl.sendCommand("$29=" + l2);
        });
    }

    if (ui.btnConfSteps) {
        ui.btnConfSteps.addEventListener("click", () => {
        const steps = Number(prompt("Moteur Steps/Rev (ex: 200):", "200"));
        const micro = Number(prompt("Microsteps (ex: 16):", "16"));
        const ratio = Number(prompt("Ratio Reduction (ex: 5):", "1"));
        if (!Number.isFinite(steps) || !Number.isFinite(micro) || !Number.isFinite(ratio)) return;

        const stepsPerRev = steps * micro * ratio;
        const stepsPerDeg = stepsPerRev / 360;
        const ok = confirm(`Calcule: ${stepsPerRev} steps/rev -> ${stepsPerDeg.toFixed(3)} steps/degre. Appliquer ?`);
        if (!ok) return;
        grbl.sendCommand("$100=" + stepsPerDeg.toFixed(3));
        grbl.sendCommand("$101=" + stepsPerDeg.toFixed(3));
        });
    }
}

grbl.onConnect = () => {
    ui.btnConnect.innerText = "Deconnecter";
    ui.btnConnect.style.background = "#c0392b";
    ui.statusText.innerText = "Connecte";
    ui.statusText.style.color = "#2ecc71";
};

grbl.onDisconnect = () => {
    ui.btnConnect.innerText = "Connecter Robot";
    ui.btnConnect.style.background = "#3498db";
    ui.statusText.innerText = "Deconnecte";
    ui.statusText.style.color = "#e74c3c";
};

grbl.onProgress = percent => {
    ui.statusText.innerText = `Impression: ${percent}%`;
};

grbl.onLog = (msg, type) => {
    if (!ui.logDiv) return;

    const div = document.createElement("div");
    const ts = new Date().toLocaleTimeString();
    div.style.fontFamily = "Consolas, monospace";
    div.style.borderBottom = "1px solid #333";
    div.style.padding = "2px";

    if (type === "tx") {
        div.style.color = "#f1c40f";
        div.innerText = `[${ts}] > ${msg}`;
    } else if (type === "rx") {
        div.style.color = "#bdc3c7";
        div.innerText = `[${ts}] < ${msg}`;
    } else if (type === "error") {
        div.style.color = "#e74c3c";
        div.innerText = `[${ts}] ! ${msg}`;
    } else if (type === "success") {
        div.style.color = "#2ecc71";
        div.innerText = `[${ts}] * ${msg}`;
    } else {
        div.style.color = "#3498db";
        div.innerText = `[${ts}] i ${msg}`;
    }

    ui.logDiv.appendChild(div);
    ui.logDiv.scrollTop = ui.logDiv.scrollHeight;
};