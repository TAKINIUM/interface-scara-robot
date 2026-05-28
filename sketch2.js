const PAPER_W = 297;
const PAPER_H = 210;
const PEN_UP = "M03 S0\n";
const PEN_DOWN = "M03 S20\n";
const FEED_MOVE = "5000";
const FEED_RAPID = "10000";

let pointPaths = [];
let viewScale = 2;
let viewOffset = { x: 50, y: 50 };
let showTravelMoves = false;
let currentProcessedSVG = "";
let tempImg = null;
let loadedExternalGcode = null;
let previewUpdateTimer = null;

const TRACE_SETTINGS = {
    threshold: 0.5,
    invert: false,
    edge: false,
    contrast: 0,
    smooth: 0,
    detail: 3
};