const PAPER_W = 297
const PAPER_H = 210
const PEN_UP = "M03 S0\n"
const PEN_DOWN = "M03 S20\n"
const FEED_MOVE = "5000"
const FEED_RAPID = "10000"

let pointPaths = []
let viewScale = 2
let viewOffset = { x: 50, y: 50 }
let showTravelMoves = false
let currentProcessedSVG = ""
let tempImg = null
let loadedExternalGcode = null
let previewUpdateTimer = null
let manualModeActive = false
let manualInterval = null
let keysPressed = {}

const TRACE_SETTINGS = {
    threshold: 0.5,
    invert: false,
    edge: false,
    contrast: 0,
    smooth: 0,
    detail: 3
}

function setup() {
    const container = document.getElementById("canvas-container")
    const w = container ? container.offsetWidth : windowWidth * 0.8
    const h = container ? container.offsetHeight : windowHeight * 0.7

    const canvas = createCanvas(w, h)
    canvas.parent("canvas-container")
    pixelDensity(1)
    noLoop()

    bindUiEvents()
    resetView()
    requestRender()
}

function bindUiEvents() {
    document.getElementById("fileInput").addEventListener("change", handleFile)
    document.getElementById("btnGcode").addEventListener("click", exportGcode)
    document.getElementById("btnReset").addEventListener("click", () => {
        resetView()
        requestRender()
    })
    document.getElementById("btnToggleTravel").addEventListener("click", toggleTravelMoves)
    document.getElementById("btnCancelModal").addEventListener("click", closeOptions)
    document.getElementById("btnConfirmModal").addEventListener("click", confirmImg)

    ;["modalThreshold", "modalInvert", "modalEdge", "modalContrast", "modalSmooth", "modalDetail"].forEach(id => {
        const el = document.getElementById(id)
        if (!el) return
        const eventName = el.type === "checkbox" ? "change" : "input"
        el.addEventListener(eventName, () => schedulePreviewUpdate(false))
    })

    const btnToggleManualMode = document.getElementById("btnToggleManualMode")
    if (btnToggleManualMode) {
        btnToggleManualMode.addEventListener("click", () => {
            manualModeActive = !manualModeActive
            btnToggleManualMode.innerText = "MODE MANUEL: " + (manualModeActive ? "ON" : "OFF")
            btnToggleManualMode.style.background = manualModeActive ? "#2ecc71" : "#e67e22"
            if (manualModeActive) {
                startManualLoop()
            } else {
                stopManualLoop()
            }
        })
    }

    window.addEventListener("keydown", (e) => {
        if (!manualModeActive || document.activeElement.tagName === "INPUT") return
        const k = e.key.toLowerCase()
        if (["z", "q", "s", "d", "r", "f"].includes(k)) {
            keysPressed[k] = true
            e.preventDefault()
        }
    })

    window.addEventListener("keyup", (e) => {
        if (!manualModeActive) return
        const k = e.key.toLowerCase()
        if (["z", "q", "s", "d", "r", "f"].includes(k)) {
            delete keysPressed[k]
            e.preventDefault()
            if (Object.keys(keysPressed).length === 0) {
                grbl.sendRealtime("\x85")
            }
        }
    })
}

function startManualLoop() {
    if (manualInterval) clearInterval(manualInterval)
    manualInterval = setInterval(() => {
        if (!manualModeActive || Object.keys(keysPressed).length === 0) return

        let dx = 0
        let dy = 0
        let dz = 0
        const stepXY = 1.5
        const stepZ = 0.5 // Plus petit pas pour ne pas dépasser les limites (soft limits) du servo
        const feedXY = 6000
        const feedZ = 1000 // Vitesse réduite pour Z pour éviter un blocage de commande

        if (keysPressed["z"]) dy += stepXY
        if (keysPressed["s"]) dy -= stepXY
        if (keysPressed["q"]) dx -= stepXY
        if (keysPressed["d"]) dx += stepXY
        if (keysPressed["r"]) dz += stepZ
        if (keysPressed["f"]) dz -= stepZ

        if (dx !== 0 || dy !== 0 || dz !== 0) {
            const parts = []
            if (dx !== 0) parts.push(`X${dx.toFixed(2)}`)
            if (dy !== 0) parts.push(`Y${dy.toFixed(2)}`)
            if (dz !== 0) parts.push(`Z${dz.toFixed(2)}`)
            
            // Si seul le Z bouge, on s'assure d'utiliser son Feedrate, sinon on maintient le feed XY
            const feed = (dx === 0 && dy === 0) ? feedZ : feedXY
            const cmd = `$J=G91 ${parts.join(" ")} F${feed}`
            grbl.sendJog(cmd)
        }
    }, 30)
}

function stopManualLoop() {
    if (manualInterval) {
        clearInterval(manualInterval)
        manualInterval = null
    }
    keysPressed = {}
    grbl.sendRealtime("\x85")
}

function windowResized() {
    const container = document.getElementById("canvas-container")
    if (!container) return
    resizeCanvas(container.offsetWidth, container.offsetHeight)
    resetView()
    requestRender()
}

function requestRender() {
    redraw()
}

function handleFile(event) {
    const file = event.target.files[0]
    if (!file) return

    pointPaths = []
    loadedExternalGcode = null

    const filename = file.name.toLowerCase()
    if (filename.endsWith(".gcode") || filename.endsWith(".nc") || filename.endsWith(".txt")) {
        const reader = new FileReader()
        reader.onload = function(e) {
            loadedExternalGcode = String(e.target.result || "")
            parseGcode(loadedExternalGcode)
            autoFit()
            requestRender()
        }
        reader.readAsText(file)
        return
    }

    if (file.type.startsWith("image/")) {
        openImageOptions(URL.createObjectURL(file))
        return
    }

    const reader = new FileReader()
    reader.onload = function(e) {
        parseSVG(String(e.target.result || ""))
        autoFit()
        requestRender()
    }
    reader.readAsText(file)
}

function openImageOptions(url) {
    document.getElementById("imageModal").style.display = "flex"
    tempImg = new Image()
    tempImg.onload = function() {
        schedulePreviewUpdate(true)
    }
    tempImg.src = url
}

function closeOptions() {
    document.getElementById("imageModal").style.display = "none"
    document.getElementById("fileInput").value = ""
    tempImg = null
    currentProcessedSVG = ""
    if (previewUpdateTimer) {
        clearTimeout(previewUpdateTimer)
        previewUpdateTimer = null
    }
}

function schedulePreviewUpdate(immediate = false) {
    if (previewUpdateTimer) clearTimeout(previewUpdateTimer)
    if (immediate) {
        preview()
        return
    }
    previewUpdateTimer = setTimeout(preview, 150)
}

function preview() {
    if (!tempImg) return

    readTraceSettings()

    const maxDim = 600
    const ratio = Math.min(1, maxDim / Math.max(tempImg.width, tempImg.height))
    const tw = Math.max(1, Math.floor(tempImg.width * ratio))
    const th = Math.max(1, Math.floor(tempImg.height * ratio))

    const canvas = document.createElement("canvas")
    canvas.width = tw
    canvas.height = th
    const ctx = canvas.getContext("2d", { willReadFrequently: true })

    ctx.drawImage(tempImg, 0, 0, tw, th)
    const imgData = ctx.getImageData(0, 0, tw, th)

    const gray = grayBuffer(imgData.data, TRACE_SETTINGS.contrast)
    const smoothGray = TRACE_SETTINGS.smooth > 0 ? blurGray(gray, tw, th, TRACE_SETTINGS.smooth) : gray
    const finalGray = TRACE_SETTINGS.edge ? sobel(smoothGray, tw, th) : smoothGray

    binarryAlpha(imgData.data, finalGray, TRACE_SETTINGS.threshold, TRACE_SETTINGS.invert)

    const d = TRACE_SETTINGS.detail
    const options = {
        ltres: map(d, 1, 5, 1.5, 0.5),
        qtres: map(d, 1, 5, 1.5, 0.5),
        pathomit: Math.round(map(d, 1, 5, 15, 2)),
        rightangleenhance: true,
        colorsampling: 0,
        numberofcolors: 2,
        mincolorratio: 0,
        blurradius: 0,
        blurdelta: 20
    }

    currentProcessedSVG = ImageTracer.imagedataToSVG(imgData, options)

    const prevContainer = document.getElementById("previewContainer")
    prevContainer.innerHTML = currentProcessedSVG
    const svgEl = prevContainer.querySelector("svg")
    if (svgEl) {
        svgEl.style.width = "100%"
        svgEl.style.height = "100%"
    }
}

function readTraceSettings() {
    const elThreshold = document.getElementById("modalThreshold")
    const elInvert = document.getElementById("modalInvert")
    const elEdge = document.getElementById("modalEdge")
    const elContrast = document.getElementById("modalContrast")
    const elSmooth = document.getElementById("modalSmooth")
    const elDetail = document.getElementById("modalDetail")

    if (elThreshold) TRACE_SETTINGS.threshold = clampNumber(parseFloat(elThreshold.value), 0, 1, 0.5)
    if (elInvert) TRACE_SETTINGS.invert = !!elInvert.checked
    if (elEdge) TRACE_SETTINGS.edge = !!elEdge.checked
    if (elContrast) TRACE_SETTINGS.contrast = clampNumber(parseFloat(elContrast.value), -1, 1, 0)
    if (elSmooth) TRACE_SETTINGS.smooth = clampNumber(parseInt(elSmooth.value, 10), 0, 4, 0)
    if (elDetail) TRACE_SETTINGS.detail = clampNumber(parseInt(elDetail.value, 10), 1, 5, 3)
}

function grayBuffer(rgba, contrast) {
    const out = new Uint8Array(rgba.length / 4)
    const factor = (259 * (contrast * 255 + 255)) / (255 * (259 - contrast * 255))

    for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
        const g = 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2]
        out[p] = clampByte(factor * (g - 128) + 128)
    }
    return out
}

function blurGray(gray, w, h, rad) {
    let src = gray
    let dst = new Uint8Array(gray.length)

    for (let pass = 0; pass < rad; pass++) {
        for (let y = 0; y < h; y++) {
            const y0 = Math.max(0, y - 1)
            const y1 = Math.min(h - 1, y + 1)
            for (let x = 0; x < w; x++) {
                const x0 = Math.max(0, x - 1)
                const x1 = Math.min(w - 1, x + 1)
                let sum = 0
                let count = 0
                for (let yy = y0; yy <= y1; yy++) {
                    for (let xx = x0; xx <= x1; xx++) {
                        sum += src[yy * w + xx]
                        count++
                    }
                }
                dst[y * w + x] = Math.round(sum / count)
            }
        }
        const t = src
        src = dst
        dst = t
    }
    return src
}

function sobel(gray, w, h) {
    const out = new Uint8Array(gray.length)
    out.fill(255)

    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            const p00 = gray[(y - 1) * w + (x - 1)]
            const p02 = gray[(y - 1) * w + (x + 1)]
            const p10 = gray[y * w + (x - 1)]
            const p12 = gray[y * w + (x + 1)]
            const p20 = gray[(y + 1) * w + (x - 1)]
            const p22 = gray[(y + 1) * w + (x + 1)]

            const gx = -p00 + p02 - 2 * p10 + 2 * p12 - p20 + p22
            const gy = -p00 - 2 * gray[(y - 1) * w + x] - p02 + p20 + 2 * gray[(y + 1) * w + x] + p22

            const mag = Math.sqrt(gx * gx + gy * gy)
            out[y * w + x] = 255 - Math.min(255, mag)
        }
    }
    return out
}

function binarryAlpha(rgba, gray, threshold, invert) {
    const gate = threshold * 255
    for (let i = 0, p = 0; i < rgba.length; i += 4, p++) {
        const isDark = gray[p] < gate
        const drawPixel = invert ? !isDark : isDark

        if (drawPixel) {
            rgba[i] = 0
            rgba[i + 1] = 0
            rgba[i + 2] = 0
            rgba[i + 3] = 255
        } else {
            rgba[i + 3] = 0
        }
    }
}

function confirmImg() {
    if (!currentProcessedSVG) return
    parseSVG(currentProcessedSVG)
    autoFit()
    requestRender()
    closeOptions()
}

function parseGcode(gcodeStr) {
    const lines = gcodeStr.split("\n")
    const raw = []
    let currentPath = []
    let lx = 0
    let ly = 0
    let isPenDown = false

    lines.forEach(line => {
        const c = line.trim().toUpperCase()
        if (!c || c.startsWith(";")) return

        if (c.includes("M03 S20")) isPenDown = true
        if (c.includes("M03 S0")) isPenDown = false

        if (!c.startsWith("G0") && !c.startsWith("G1")) return

        const xMatch = /X([\d.-]+)/.exec(c)
        const yMatch = /Y([\d.-]+)/.exec(c)

        const x = xMatch ? parseFloat(xMatch[1]) : lx
        const yg = yMatch ? parseFloat(yMatch[1]) : ly
        const yc = PAPER_H - yg

        if (c.startsWith("G0") || !isPenDown) {
            if (currentPath.length > 1) raw.push(currentPath)
            currentPath = []
        } else {
            if (currentPath.length === 0) {
                currentPath.push({ x: lx, y: PAPER_H - ly })
            }
            currentPath.push({ x, y: yc })
        }
        lx = x
        ly = yg
    })

    if (currentPath.length > 1) raw.push(currentPath)
    pointPaths = normalizeDrawingPaths(raw, false)
}

function parseSVG(xmlString) {
    const parser = new DOMParser()
    const doc = parser.parseFromString(xmlString, "image/svg+xml")
    const svgPaths = Array.from(doc.querySelectorAll("path"))
    const raw = []

    for (const origPath of svgPaths) {
        const dAttr = origPath.getAttribute("d")
        if (!dAttr) continue

        const subCommands = dAttr.split(/(?=[Mm])/).filter(s => s.trim().length > 0)

        for (const sc of subCommands) {
            const path = document.createElementNS("http://www.w3.org/2000/svg", "path")
            path.setAttribute("d", sc)

            const len = path.getTotalLength()
            if (!Number.isFinite(len) || len < 1.5) continue

            const step = Math.max(0.5, len / 1000)
            const splitThreshold = Math.max(3.0, step * 4)

            let points = []
            let lastP = null

            for (let d = 0; d <= len; d += step) {
                const p = path.getPointAtLength(d)
                const pt = { x: p.x, y: p.y }

                if (lastP && Math.sqrt(distSq(lastP.x, lastP.y, pt.x, pt.y)) > splitThreshold) {
                    if (points.length > 1) raw.push(points)
                    points = []
                }
                points.push(pt)
                lastP = pt
            }
            if (points.length > 1) raw.push(points)
        }
    }
    pointPaths = normalizeDrawingPaths(raw, true)
}

function normalizeDrawingPaths(rawPaths, reorder) {
    let paths = rawPaths
        .flatMap(p => splitPathOnJumps(cleanupPath(p, 0.1, 0.25)))
        .filter(p => p.length > 1 && pathLength(p) >= 1.5)

    paths = removeDuplicatePaths(paths, 0.5, 0.75)
    return reorder ? reorderByNearest(paths) : paths
}

function splitPathOnJumps(path) {
    if (!path || path.length < 3) {
        return path && path.length > 1 ? [path] : []
    }
    const lens = []
    for (let i = 1; i < path.length; i++) {
        lens.push(Math.sqrt(distSq(path[i - 1].x, path[i - 1].y, path[i].x, path[i].y)))
    }
    const sorted = lens.slice().sort((a, b) => a - b)
    const median = sorted[Math.floor(sorted.length / 2)] || 0
    const limit = Math.max(3.0, median * 5)

    const pieces = []
    let currentPiece = [path[0]]

    for (let i = 1; i < path.length; i++) {
        const d = Math.sqrt(distSq(path[i - 1].x, path[i - 1].y, path[i].x, path[i].y))
        if (d > limit) {
            if (currentPiece.length > 1) pieces.push(currentPiece)
            currentPiece = [path[i]]
            continue
        }
        currentPiece.push(path[i])
    }
    if (currentPiece.length > 1) pieces.push(currentPiece)
    return pieces
}

function cleanupPath(path, minPointGap, simplifyTolerance) {
    if (!path || path.length < 2) return []

    const compact = [path[0]]
    for (let i = 1; i < path.length; i++) {
        if (distSq(compact[compact.length - 1].x, compact[compact.length - 1].y, path[i].x, path[i].y) >= minPointGap * minPointGap) {
            compact.push(path[i])
        }
    }
    if (compact.length < 2) return []

    if (distSq(compact[0].x, compact[0].y, compact[compact.length - 1].x, compact[compact.length - 1].y) < minPointGap * minPointGap) {
        compact.pop()
    }

    if (compact.length < 3) return compact
    return simplifyRDP(compact, simplifyTolerance)
}

function simplifyRDP(points, epsilon) {
    if (points.length < 3) return points
    const first = points[0]
    const last = points[points.length - 1]

    let maxD = -1
    let index = -1

    for (let i = 1; i < points.length - 1; i++) {
        const d = pointLineDistance(points[i], first, last)
        if (d > maxD) {
            maxD = d
            index = i
        }
    }

    if (maxD <= epsilon || index === -1) {
        return [first, last]
    }

    const rec1 = simplifyRDP(points.slice(0, index + 1), epsilon)
    const rec2 = simplifyRDP(points.slice(index), epsilon)
    return rec1.slice(0, -1).concat(rec2)
}

function pointLineDistance(p, a, b) {
    const dx = b.x - a.x
    const dy = b.y - a.y
    if (dx === 0 && dy === 0) {
        return Math.sqrt(distSq(p.x, p.y, a.x, a.y))
    }
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (dx * dx + dy * dy)))
    return Math.sqrt(distSq(p.x, p.y, a.x + t * dx, a.y + t * dy))
}

function removeDuplicatePaths(paths, grid, duplicateRatio) {
    const kept = []
    const seenSegments = new Set()

    for (const path of paths) {
        let totalSegments = 0
        let duplicateSegments = 0

        for (let i = 1; i < path.length; i++) {
            totalSegments++
            const key = segmentKey(path[i - 1], path[i], grid)
            if (seenSegments.has(key)) {
                duplicateSegments++
            }
        }

        if (totalSegments > 0 && (duplicateSegments / totalSegments) >= duplicateRatio) {
            continue
        }

        kept.push(path)
        for (let i = 1; i < path.length; i++) {
            seenSegments.add(segmentKey(path[i - 1], path[i], grid))
        }
    }
    return kept
}

function segmentKey(a, b, grid) {
    const ax = Math.round(a.x / grid)
    const ay = Math.round(a.y / grid)
    const bx = Math.round(b.x / grid)
    const by = Math.round(b.y / grid)
    if (ax < bx || (ax === bx && ay <= by)) {
        return `${ax},${ay}|${bx},${by}`
    }
    return `${bx},${by}|${ax},${ay}`
}

function pathLength(path) {
    let sum = 0
    for (let i = 1; i < path.length; i++) {
        sum += Math.sqrt(distSq(path[i - 1].x, path[i - 1].y, path[i].x, path[i].y))
    }
    return sum
}

function autoFit() {
    if (pointPaths.length === 0) return

    let minX = Infinity
    let minY = Infinity
    let maxX = -Infinity
    let maxY = -Infinity

    pointPaths.forEach(path => {
        path.forEach(p => {
            if (p.x < minX) minX = p.x
            if (p.y < minY) minY = p.y
            if (p.x > maxX) maxX = p.x
            if (p.y > maxY) maxY = p.y
        })
    })

    const w = maxX - minX
    const h = maxY - minY
    const finalScale = Math.min((PAPER_W * 0.9) / Math.max(1, w), (PAPER_H * 0.9) / Math.max(1, h))

    const ox = (PAPER_W - w * finalScale) / 2
    const oy = (PAPER_H - h * finalScale) / 2

    pointPaths = pointPaths.map(path => {
        return path.map(p => ({
            x: (p.x - minX) * finalScale + ox,
            y: (p.y - minY) * finalScale + oy
        }))
    })
}

function draw() {
    background(44, 62, 80)

    push()
    translate(viewOffset.x, viewOffset.y)
    scale(viewScale)

    fill(255)
    noStroke()
    rect(0, 0, PAPER_W, PAPER_H)

    strokeWeight(0.5 / viewScale)
    noFill()

    let lx = 0
    let ly = 0

    for (const path of pointPaths) {
        if (path.length === 0) continue

        if (showTravelMoves) {
            stroke(231, 76, 60, 100)
            line(lx, ly, path[0].x, path[0].y)
        }

        stroke(41, 128, 185)
        beginShape()
        for (const p of path) {
            vertex(p.x, p.y)
        }
        endShape()

        lx = path[path.length - 1].x
        ly = path[path.length - 1].y
    }

    if (showTravelMoves && pointPaths.length > 0) {
        stroke(231, 76, 60, 100)
        line(lx, ly, 0, 0)
    }

    pop()
}

function mouseWheel(event) {
    viewScale = constrain(viewScale - event.delta * 0.001, 0.1, 10)
    requestRender()
    return false
}

function mouseDragged() {
    if (mouseX > 0 && mouseX < width && mouseY > 0 && mouseY < height) {
        viewOffset.x += movedX
        viewOffset.y += movedY
        requestRender()
    }
}

function resetView() {
    viewScale = Math.min(width / (PAPER_W * 1.1), height / (PAPER_H * 1.1))
    viewOffset.x = (width - PAPER_W * viewScale) / 2
    viewOffset.y = (height - PAPER_H * viewScale) / 2
}

function toggleTravelMoves() {
    showTravelMoves = !showTravelMoves
    const btn = document.getElementById("btnToggleTravel")
    btn.innerText = "TRAVEL: " + (showTravelMoves ? "ON" : "OFF")
    btn.style.background = showTravelMoves ? "#e67e22" : "#3498db"
    requestRender()
}

function getCurrentGcode() {
    if (loadedExternalGcode) return loadedExternalGcode
    if (pointPaths.length === 0) return null

    const optimized = reorderByNearest(pointPaths.map(p => p.slice()))
    let gcode = "G90\n" + PEN_UP + `G0 F${FEED_RAPID} X0 Y0\n`
    let lastOutX = null
    let lastOutY = null

    optimized.forEach(path => {
        if (path.length < 2) return

        const startX = path[0].x
        const startY = PAPER_H - path[0].y
        gcode += `G0 X${startX.toFixed(3)} Y${startY.toFixed(3)}\n`
        gcode += PEN_DOWN

        lastOutX = startX
        lastOutY = startY

        for (let i = 1; i < path.length; i++) {
            const x = path[i].x
            const y = PAPER_H - path[i].y
            if (lastOutX !== null && distSq(x, y, lastOutX, lastOutY) < 0.01) {
                continue
            }
            gcode += `G1 X${x.toFixed(3)} Y${y.toFixed(3)} F${FEED_MOVE}\n`
            lastOutX = x
            lastOutY = y
        }

        gcode += PEN_UP
    })

    gcode += "G0 X0 Y0\n"
    return gcode
}

function reorderByNearest(paths) {
    if (paths.length < 2) return paths

    const remaining = paths.map(p => ({ path: p }))
    const ordered = []
    let currentPos = { x: 0, y: 0 }

    while (remaining.length > 0) {
        let nearestIndex = 0
        let shouldReverse = false
        let minDistanceSq = Infinity

        for (let i = 0; i < remaining.length; i++) {
            const p = remaining[i].path
            const dStart = distSq(currentPos.x, currentPos.y, p[0].x, p[0].y)
            const dEnd = distSq(currentPos.x, currentPos.y, p[p.length - 1].x, p[p.length - 1].y)

            if (dStart < minDistanceSq) {
                minDistanceSq = dStart
                nearestIndex = i
                shouldReverse = false
            }
            if (dEnd < minDistanceSq) {
                minDistanceSq = dEnd
                nearestIndex = i
                shouldReverse = true
            }
        }

        const nextPath = remaining.splice(nearestIndex, 1)[0].path
        const chosenPath = shouldReverse ? nextPath.slice().reverse() : nextPath

        ordered.push(chosenPath)
        currentPos = chosenPath[chosenPath.length - 1]
    }

    return ordered
}

function exportGcode() {
    const gcode = getCurrentGcode()
    if (!gcode) {
        alert("Aucun dessin !")
        return
    }

    const blob = new Blob([gcode], { type: "text/plain" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = "Drawing.gcode"
    a.click()
    URL.revokeObjectURL(url)
}

function distSq(x1, y1, x2, y2) {
    return (x2 - x1) * (x2 - x1) + (y2 - y1) * (y2 - y1)
}

function clampByte(v) {
    return v < 0 ? 0 : (v > 255 ? 255 : v | 0)
}

function clampNumber(v, min, max, fallback) {
    if (!Number.isFinite(v)) return fallback
    return v < min ? min : (v > max ? max : v)
}