const port = process.env.PORT || 8000;
const fs = require('fs');
const fetch = require("node-fetch");
const express = require("express");
const WebSocket = require('ws');
const bodyParser = require('body-parser');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');
const sharp = require('sharp');
const archiver = require('archiver');
// const dovenv = require('dotenv').config();
const app = express();
const Sequelize = require('sequelize');
app.use(express.static('static'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

var IDCounter = 1;
var sessCounter = 1;
var sessions = {};
const cardwidth = 6.299;
const cardheight = 8.788;
const cardwidthPt = cmToPt(cardwidth);
const cardheightPt = cmToPt(cardheight);
const storagePath = "https://proxynexus.blob.core.windows.net/";
const altArtCards = JSON.parse(fs.readFileSync('static/json/altart.json')).altArtCards;

app.post('/api/makePDF', function (req, res) {
    // unpack request
    const sessID = req.body.sessID;
    const paperSize = req.body.paperSize;
    const quality = req.body.quality;
    const includeBackArt = req.body.includeBackArt;
    const fullCutLines = req.body.fullCutLines;
    const selectedSet = req.body.selectedSet;
    const logInfo = req.body.logInfo;
    const container = ((q, set) => {
        if (set === "sc19-german" || set === "rar-german") {
            switch(q) {
                case 'High':
                    return 'german-images/';
                case 'Medium':
                    return 'german-med-images/';
            }
        } else {
            switch(q) {
                case 'High':
                    return 'images/';
                case 'Medium':
                    return 'med-images/';
            }
        }
    })(quality, selectedSet);
    const requestedImages = req.body.requestedImages;
    const downloadID = IDCounter;
    IDCounter = IDCounter + 1;
    const ws = sessions[sessID];
    const requestStr = "DownloadID: "+downloadID+"; Papersize: "+paperSize+", Quality: "+quality+", CutLines: "+fullCutLines+", "+logInfo;
    console.log("PDF Request! " + requestStr);

    res.status(200);
    res.end();

    // Catch empty image request, and return error message
    if (requestedImages.length == 0) {
        console.error("DownloadID " + downloadID + ": No images requested");
        res.status(200);
        sendMsgToClient(ws, {"success": false, "errorMsg": "No images requested.", "reqType": "pdf" });
        return;
    }

    // determine margin sizes from selected paper size, return error if chouse is missing
    if (paperSize === 'A4') {
        var leftMargin = 30;
        var topMargin = 46;
    }
    else if (paperSize === 'Letter') {
        var leftMargin = 36;
        var topMargin = 21;
    } else {
        console.error("DownloadID " + downloadID + ": Invalid paper size");
        sendMsgToClient(ws, { "success": false, "errorMsg": "Invalid paper size", "reqType": "pdf" })
        return;
    }

    // Catch missing image selection. Container would be null since it won't hit either case in assignment
    if (container == null) {
        console.error("DownloadID " + downloadID + ": No image quality selected");
        sendMsgToClient(ws, { "success": false, "errorMsg": "No image quality selected", "reqType": "pdf" });
        return;
    }

    // request is good, make hash for request and pdf file name
    const requestedPDFOptions = paperSize + quality + fullCutLines + includeBackArt + requestedImages + logInfo;
    const hash = crypto.createHash('sha1').update(requestedPDFOptions).digest('hex');
    const pdfFileName = hash + ".pdf";
    const pdfPath = __dirname + "/static/tmp/" + pdfFileName;
    console.log("DownloadID " + downloadID + ": PDF Name: " + pdfFileName);

    // check if requested pdf or zip was already generated, save from re-generating it
    if (fs.existsSync(pdfPath)) {
        const fileName = "/tmp/" + pdfFileName;
        console.log("DownloadID " + downloadID + ": PDF already exists, don't generate");
        console.log("DownloadID " + downloadID + ": Sent " + fileName + " to Session " + ws.id);
        sendMsgToClient(ws, { "success": true, "downloadLink": fileName, "reqType": "pdf" });
        return;
    }
    const zipPath = pdfPath.split(".")[0] + ".zip";
    const zipFileName = pdfFileName.split('.')[0] + ".zip";
    if (fs.existsSync(zipPath)) {
        const fileName = "/tmp/" + zipFileName;
        console.log("DownloadID " + downloadID + ": PDFs in zip file already exists, don't generate");
        console.log("DownloadID " + downloadID + ": Sent " + fileName + " to Session "  + ws.id);
        sendMsgToClient(ws, { "success": true, "downloadLink": fileName, "reqType": "pdf" });
        return;
    }

    const opt = {
        container: container,
        quality: quality,
        includeBackArt: includeBackArt,
        downloadID: downloadID,
        pdfFileName: pdfFileName,
        requestedImages: requestedImages,
        pdfPath: pdfPath,
        paperSize: paperSize,
        fullCutLines: fullCutLines,
        topMargin: topMargin,
        leftMargin: leftMargin,
        ws: ws,
        requestStr: requestStr,
    };
    fetchImagesForPDF(opt);
});

async function fetchImagesForPDF(opt) {	
    const container = opt.container;
    const quality = opt.quality;
    const includeBackArt = opt.includeBackArt;
    const downloadID = opt.downloadID;
    const pdfFileName = opt.pdfFileName
    const requestedImages = opt.requestedImages;
    const pdfPath = opt.pdfPath;
    const paperSize = opt.paperSize;
    const fullCutLines = opt.fullCutLines;
    const topMargin = opt.topMargin;
    const leftMargin = opt.leftMargin;
    const ws = opt.ws;
    const requestStr = opt.requestStr;

    // Add back side art for flippable IDs and alt art
    var imgCodes = addFlippedIds(requestedImages);
    if (includeBackArt) {
        imgCodes = addAltArtBacks(imgCodes);
    }

    // Strip duplicate and already downloaded image codes, to prevent downloading more than needed
    const imgFileNames = imgCodes.map(code => {return code + ".jpg"});	// used for building document later, need to maintain img count
    const uniqueImgCodes = [...new Set(imgFileNames)];
    const imgCodesToFetch = uniqueImgCodes.filter( code => {
        const imgPath = "./static/tmp/" + container + code;
        const onExistsMsg = "DownloadID " + downloadID + ": Found cached copy of " + code + ", don't download";
        return doesNotExists(imgPath, onExistsMsg);
    });

    // Download image files, and wait until all are ready
    console.log("DownloadID " + downloadID + ": Code list ready, Fetching images...");
    sendMsgToClient(ws, { "status": "Fetching images...", "reqType": "pdf" });
    const imgPath = "./static/tmp/" + container;
    const url = storagePath + container;
    try {
        await downloadFiles(imgCodesToFetch, imgPath, url, downloadID);
    }
    catch(err) {
        console.error("DownloadID " + downloadID + ": " + err.message);
        sendMsgToClient(ws, { "success": false, "errorMsg": "Error fetching images, try again.", "reqType": "pdf" });
        return;
    }

    console.log("DownloadID " + downloadID + ": Adding images to doc...");
    sendMsgToClient(ws, { "status": "Adding images to pdf...", "reqType": "pdf" });
    const CARDS_PER_PDF = 144
    if (imgFileNames.length <= CARDS_PER_PDF) {
        const doc = new PDFDocument({
            size: paperSize,
            margins: {
                top: topMargin,
                bottom: topMargin,
                left: leftMargin,
                right: leftMargin
              }
        });

        doc.pipe(fs.createWriteStream(pdfPath));
        makeFrontPage(doc, quality);
        doc.addPage();
        addImages(imgFileNames, doc, container, leftMargin, topMargin, fullCutLines);
        doc.end();
        var fileName = "/tmp/" + pdfFileName;
        console.log("DownloadID " + downloadID + ": Sent " + fileName + " to Session " + ws.id);
        sendMsgToClient(ws, { "success": true, "downloadLink": fileName, "reqType": "pdf" });
        return;
    } else {
        console.log("DownloadID " + downloadID + ": Large PDF, splitting it up...")

        const docNum = Math.ceil(imgFileNames.length / CARDS_PER_PDF);
        const splitPDFPath = pdfPath.split(".");
        var allSplitPDFs = [];

        for (var i=0; i<docNum; i++) {
            const doc = new PDFDocument({
                size: paperSize,
                margins: {
                    top: topMargin,
                    bottom: topMargin,
                    left: leftMargin,
                    right: leftMargin
                  }
            });
            const lowerIndex = i * CARDS_PER_PDF;
            if ( (i+1)*CARDS_PER_PDF > imgFileNames.length ) {
                var upperIndex = imgFileNames.length
            } else {
                var upperIndex = (i+1)*CARDS_PER_PDF;
            }

            const splitPdfFileName = pdfFileName.split('.')[0] + "-" + (i+1) + ".pdf";
            allSplitPDFs.push(splitPdfFileName);
            const splitPDF = splitPDFPath[0] + "-" + (i+1) + ".pdf";
            doc.pipe(fs.createWriteStream(splitPDF));
            makeFrontPage(doc, quality);
            doc.addPage();
            addImages(imgFileNames.slice(lowerIndex, upperIndex), doc, container, leftMargin, topMargin, fullCutLines);
            doc.end();
        }

        sendMsgToClient(ws, { "status": "Adding pdfs to zip file...", "reqType": "pdf" });
        console.log("DownloadID " + downloadID + ": Zipping up pdfs...");

        const zipPath = splitPDFPath[0] + ".zip";
        const zipFileName = pdfFileName.split('.')[0] + ".zip";
        var zipFile = fs.createWriteStream(zipPath);
        var archive = archiver('zip', {
            zlib: { level: 0 }
        });
        zipFile.on('close', function() {
            const fileName = "/tmp/" + zipFileName;
            console.log("DownloadID " + downloadID + ": Zip file ready, " + archive.pointer() + " total bytes");
            console.log("DownloadID " + downloadID + ": Sent " + fileName + " to Session " + ws.id);
            sendMsgToClient(ws, { "success": true, "downloadLink": fileName, "reqType": "pdf" });
            return;
        });

        archive.pipe(zipFile);
        allSplitPDFs.forEach(file => {
            archive.file(__dirname + "/static/tmp/" + file, { name: file });
        });
        archive.finalize();
    }
}

function addImages(lst, doc, container, leftMargin, topMargin, fullCutLines) {
    var rowCount = 0;
    var colCount = 0;

    lst.forEach((code, i) => {
        const x = rowCount*cardwidthPt + leftMargin;
        const y = colCount*cardheightPt + topMargin;
        const imgPath = "static/tmp/" + container + code;

        doc.image(imgPath, x, y, {width: cardwidthPt, height: cardheightPt});
        rowCount++;

        if (rowCount > 2) {
            rowCount = 0;
            colCount++;
        }
        if (i === lst.length - 1) {
            if (fullCutLines) {
                drawFullCutLines(doc, leftMargin, topMargin);
            } else {
                drawCutLines(doc, leftMargin, topMargin);
            }
        }
        if (colCount > 2 && i < lst.length - 1) {
            colCount = 0;
            if (fullCutLines) {
                drawFullCutLines(doc, leftMargin, topMargin);
            } else {
                drawCutLines(doc, leftMargin, topMargin);
            }
            doc.addPage();
        }
    });
    return;
}

function drawCutLines(doc, leftMargin, topMargin) {
    doc.lineWidth(0.5);

    // draw top lines
    var x = cardwidthPt + leftMargin;
    var y = topMargin;
    doc.moveTo(x, y)
        .lineTo(x, y-10)
        .stroke();
    x += cardwidthPt;
    doc.moveTo(x, y)
        .lineTo(x, y-10)
        .stroke();

    // draw lines between row 1 and 2
    x = leftMargin;
    y += cardheightPt;
    doc.moveTo(x, y)
        .lineTo(x-18, y)
        .stroke();
    x += 3*cardwidthPt;
    doc.moveTo(x, y)
        .lineTo(x+18, y)
        .stroke();

    // draw lines between row 2 and 3
    x = leftMargin;
    y += cardheightPt;
    doc.moveTo(x, y)
        .lineTo(x-18, y)
        .stroke();
    x += 3*cardwidthPt;
    doc.moveTo(x, y)
        .lineTo(x+18, y)
        .stroke();

    // draw bottom lines
    x = cardwidthPt + leftMargin;
    y += cardheightPt;
    doc.moveTo(x, y)
        .lineTo(x, y+10)
        .stroke();
    x += cardwidthPt;
    doc.moveTo(x, y)
        .lineTo(x, y+10)
        .stroke();
    return;
}

function drawFullCutLines(doc, leftMargin, topMargin) {
    doc.lineWidth(0.75);
    const greyStroke = "#818181";

    // draw vertical lines
    var x = cardwidthPt + leftMargin;
    var y = 0;
    doc.moveTo(x, y)
        .lineTo(x, y+1000)
        .stroke(greyStroke);
    x += cardwidthPt;
    doc.moveTo(x, y)
        .lineTo(x, y+1000)
        .stroke(greyStroke);

    // draw horizontal lines
    x = 0;
    y = cardheightPt + topMargin;
    doc.moveTo(x, y)
        .lineTo(x+1000, y)
        .stroke(greyStroke);
    y += cardheightPt;
    doc.moveTo(x, y)
        .lineTo(x+1000, y)
        .stroke(greyStroke);
    return;
}

function makeFrontPage(doc, quality) {
    doc.moveDown(15);
    doc.fontSize(20);
    doc.text('Generated by Proxy Nexus at https://proxynexus.net', {
        align: 'center'
    });

    doc.moveDown(3);
    doc.fontSize(14);
    doc.text('Print this PDF at 100% size with no additional margins.', {
        align: 'center'
    });

    doc.moveDown(20);
    doc.fontSize(12);
    doc.text('Image quality: ' + quality, {
        align: 'left'
    });
    doc.moveDown(1);
    doc.text('Generated on: ' + new Date().toString(), {
        align: 'left'
    });
    return;
}

function addFlippedIds(requestedImages) {
    var imgCodes = [...requestedImages];
    const biotechIndex = imgCodes.indexOf("08012");
    if (biotechIndex >= 0) {
        const extraCodes = ["08012a", "08012", "08012b", "08012", "08012c"];
        imgCodes.splice(biotechIndex + 1, 0, ...extraCodes);
    }
    const syncIndex = imgCodes.indexOf("09001");
    if (syncIndex >= 0) {
        imgCodes.splice(syncIndex + 1, 0, "09001a");
    }
    const hoshikoIndex = imgCodes.indexOf("26066");
    if (hoshikoIndex >= 0) {
        imgCodes.splice(hoshikoIndex + 1, 0, "26066a");
    }
    const earthStationIndex = imgCodes.indexOf("26120");
    if (earthStationIndex >= 0) {
        imgCodes.splice(earthStationIndex + 1, 0, "26120a");
    }
    return imgCodes;
}

function addAltArtBacks(codes) {
    var updateCodes = [];
    codes.forEach(code => {
        updateCodes.push(code);
        altArtCards.forEach(altCard => {
            if (altCard.code === code && altCard.back_code) {
                updateCodes.push(altCard.back_code);
            }
        })
    });
    return updateCodes;
}

function cmToPt (cm) {
    return cm * 28.3464566929134;
}

function sendMsgToClient(ws, msg) {
    if (ws !== null) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(msg));
        } else {
            console.log("Session " + ws.id + " NOT OPEN, tried to send: " + JSON.stringify(msg));
        }
    } else {
        console.log("WebSocket missing, tried to send: " + JSON.stringify(msg));
    }
}

// if the path does NOT exist, return true
// if the path exists, print the message and return false

function doesNotExists(path, onExistsMsg) {
    try {
        fs.statSync(path);
        if (onExistsMsg != null) {
            console.log(onExistsMsg);
        }
        return false;
    }
    catch (err) {
        if (err.code === 'ENOENT') {
            return true;
        }
    }
}

// Duplicates an image with a unique border pixel set to red
// to make this copy unique as far as MPC can tell
async function setRedPixel(orinalPath, dupPath, index, completeMsg) {
    var promise = new Promise( function(resolve, reject) {
        sharp(orinalPath)
        .composite([{ input: 'misc/redDot.png', blend: 'over', top: index, left: 0 }])
        .toFile(dupPath)
        .then( () => {
            console.log(completeMsg)
            resolve();
        })
        .catch(err => {
            console.log(err)
            reject();
        });

    });
    await promise;
    promise = null;
}

// Download all files in fileNames to destination from the baseUrl
// Needs to be called from within a try-catch block!!
async function downloadFiles(fileNames, destination, baseUrl, downloadID) {
    if (!fs.existsSync(destination)){ fs.mkdirSync(destination); }
    const promises = fileNames.map( async fileName => {
        const filePath = destination + fileName;
        const url = baseUrl + fileName;
        const imgRes = await fetch(url)
        .then( res => {
            if (!res.ok) {
                throw new Error("Error downloading: " + fileName);
            }
            console.log("DownloadID " + downloadID + ": Downloaded " + fileName);
            return res;
        });
        const fileStream = fs.createWriteStream(filePath);
        return new Promise((resolve, reject) => {
            imgRes.body.pipe(fileStream);
            imgRes.body.on("error", (err) => {
                reject(err);
            });
            fileStream.on("finish", function() {
                resolve();
            });
        });
    });
    await Promise.all(promises);
}

app.post('/api/makeMpcZip', function (req, res) {
    const sessID = req.body.sessID;
    const imagePlacement = req.body.imagePlacement;
    const includeBackArt = req.body.includeBackArt;
    const selectedSet = req.body.selectedSet;
    const logInfo = req.body.logInfo;
    const container = ((q, set) => {
        if (set === "sc19-german" || set === "rar-german") {
            switch(q) {
                case 'Scale':
                    return 'german-scaled/';
                case 'Fit':
                    return 'german-fitted/';
            }
        } else {
            switch(q) {
                case 'Scale':
                    return 'scaled/';
                case 'Fit':
                    return 'fitted/';
            }
        }
    })(imagePlacement, selectedSet);
    const fileNamePrefix = ((q) => {
        switch(q) {
            case 'Scale':
                return 'scaled/';
            case 'Fit':
                return 'fitted/';
        }
    })(imagePlacement);
    var corpCodes = req.body.corpCodes;
    var runnerCodes = req.body.runnerCodes;
    const downloadID = IDCounter;
    IDCounter = IDCounter + 1;
    const ws = sessions[sessID];
    const requestStr = "DownloadID: " + downloadID + "; Image Placement: " + imagePlacement + ", " + logInfo;
    console.log("MPC-zip Request! " + requestStr);

    res.status(200);
    res.end();

    // Catch empty image request, and return error message
    const requestedImages = corpCodes.concat(runnerCodes);
    if (requestedImages.length == 0) {
        console.error("DownloadID " + downloadID + ": No images requested");
        sendMsgToClient(ws, { "success": false, "errorMsg": "No images requested.", "reqType": "zip" });
        return;
    }

    if (imagePlacement == null) {
        console.error("DownloadID " + downloadID + ": No image placement method selected");
        sendMsgToClient(ws, { "success": false, "errorMsg": "No image placement method selected", "reqType": "zip" });
        return;
    }

    const requestedZipOptions = imagePlacement + includeBackArt + requestedImages + logInfo;
    const hash = crypto.createHash('sha1').update(requestedZipOptions).digest('hex');
    const zipFileName = hash + ".zip";
    const zipPath = __dirname + "/static/tmp/" + zipFileName;
    const zipDir = __dirname + "/static/tmp/zip-cache/" + hash + "/";
    console.log("DownloadID " + downloadID + ": Zip Name: " + zipFileName);

    if (fs.existsSync(zipPath)) {
        const fileName = "/tmp/" + zipFileName;
        console.log("DownloadID " + downloadID + ": Zip already exists, don't generate");
        console.log("DownloadID " + downloadID + ": Sent " + fileName + " to Session " + ws.id);
        sendMsgToClient(ws, { "success": true, "downloadLink": fileName, "reqType": "zip" });
        return;
    }

    if (!fs.existsSync(__dirname + "/static/tmp/zip-cache/")){
        fs.mkdirSync(__dirname + "/static/tmp/zip-cache/");
    }

    if (!fs.existsSync(zipDir)) {
        fs.mkdirSync(zipDir);
        fs.mkdirSync(zipDir + "corp/");
        fs.mkdirSync(zipDir + "runner/");
    }

    const opt = {
        container: container,
        fileNamePrefix: fileNamePrefix,
        includeBackArt: includeBackArt,
        downloadID: downloadID,
        corpCodes: corpCodes,
        runnerCodes: runnerCodes,
        ws: ws,
        zipFileName: zipFileName,
        zipDir: zipDir,
        zipPath: zipPath,
        requestStr: requestStr
    };

    fetchImagesForZip(opt);
});

async function fetchImagesForZip(opt) {
    const container = opt.container;
    const fileNamePrefix = opt.fileNamePrefix;
    const includeBackArt = opt.includeBackArt;
    const downloadID = opt.downloadID;
    const corpCodes = opt.corpCodes;
    const runnerCodes = opt.runnerCodes;
    const ws = opt.ws;
    const zipFileName = opt.zipFileName;
    const zipDir = opt.zipDir;
    const zipPath = opt.zipPath;
    const requestStr = opt.requestStr;

    var corpFileCodes = addFlippedIds(corpCodes);
    var runnerFileCodes = addFlippedIds(runnerCodes);
    if (includeBackArt) {
        corpFileCodes = addAltArtBacks(corpFileCodes);
        runnerFileCodes = addAltArtBacks(runnerFileCodes);
    }

    const corpFilesNames = 	corpFileCodes.map( code => {
        return fileNamePrefix.replace(/\/$/, "") + "-" + code + ".jpg";
    })

    const runnerFileNames = runnerFileCodes.map( code => {
        return fileNamePrefix.replace(/\/$/, "") + "-" + code + ".jpg";
    })

    // buid an object of {fileName: {count: num, side: side}
    // used for duplicating multiple copies of the same card
    var imgCounts = {}
    corpFilesNames.forEach( fileName => {
        if (fileName in imgCounts) {
            if (imgCounts[fileName].count < 99) {
                imgCounts[fileName].count++;
            }
        } else {
            imgCounts[fileName] = { "count": 1, "side": "corp" };
        }
    });
    runnerFileNames.forEach( fileName => {
        if (fileName in imgCounts) {
            if (imgCounts[fileName].count < 99) {
                imgCounts[fileName].count++;
            }
        } else {
            imgCounts[fileName] = { "count": 1, "side": "runner" };;
        }
    });

    const imgFileNames = Object.keys(imgCounts);
    const imgCodesToFetch = imgFileNames.filter( file => {
        const imgPath = "./static/tmp/" + container + file;
        const onExistsMsg = "DownloadID " + downloadID + ": Found cached copy of " + file + ", don't download";
        return doesNotExists(imgPath, onExistsMsg);
    });

    // Download image files, and wait until all are ready
    console.log("DownloadID " + downloadID + ": Code list ready, Fetching images...");
    sendMsgToClient(ws, { "status": "Fetching images...", "reqType": "zip" });
    const imgPath = "./static/tmp/" + container;
    const url = storagePath + container;
    try {
        await downloadFiles(imgCodesToFetch, imgPath, url, downloadID);
    }
    catch(err) {
        console.error("DownloadID " + downloadID + ": " + err.message);
        sendMsgToClient(ws, { "success": false, "errorMsg": "Error fetching images, try again.", "reqType": "zip" });
        return;
    }

    // download back images if they're missing
    const cardBacks = ["corp-back.png", "runner-back.png"];
    const cardBacksToFetch = cardBacks.filter( file => {
        const imgPath = "./static/tmp/zip-cache/" + file;
        return doesNotExists(imgPath, null);
    });
    if (cardBacksToFetch.length > 0) {
        const imgPath = "./static/tmp/zip-cache/";
        const url = storagePath + "misc/";
        try {
            await downloadFiles(cardBacksToFetch, imgPath, url, downloadID);
        }
        catch(err) {
            console.error("DownloadID " + downloadID + ": " + err.message);
            sendMsgToClient(ws, { "success": false, "errorMsg": "Error fetching images, try again.", "reqType": "zip" });
            return;
        }
    }

    // For duplicate images, make a copy if not already cached and save the names
    var dupCorpFiles = [];
    var dupRunnerFiles = [];
    sendMsgToClient(ws, { "status": "Preparing images...", "reqType": "zip" });
    console.log("DownloadID " + downloadID + ": Creating duplicate copies...");
    for (var i=0; i<Object.keys(imgCounts).length; i++) {
        const fileName = Object.keys(imgCounts)[i];
        const count = imgCounts[fileName].count;
        const splitName = fileName.split(".");
        for (var j=1; j<count; j++) {
            const dupName = splitName[0] + "-" + j + "." + splitName[1];
            const imgPath = "./static/tmp/" + container + dupName;
            const onExistsMsg = "DownloadID " + downloadID + ": Found " + dupName + ", a cached copy of " + fileName + ", don't duplicate";
            if (imgCounts[fileName].side === "corp") {
                dupCorpFiles.push(dupName);
            }
            if (imgCounts[fileName].side === "runner") {
                dupRunnerFiles.push(dupName);
            }
            // if duplicate missing, make a copy and set the red pixel to make it unique for MPC
            if (doesNotExists(imgPath, onExistsMsg)) {
                const originalImg = "./static/tmp/" + container + fileName;
                const msg = fileName + " being copied to " + dupName;
                await setRedPixel(originalImg, imgPath, j, msg);  // makes a copy
            }
        }
  }

    console.log("DownloadID " + downloadID + ": Duplicates Ready");
    const allCorpFiles = corpFilesNames.concat(dupCorpFiles);
    allCorpFiles.forEach( file => {
        fs.copyFileSync("./static/tmp/" + container + file, zipDir + "corp/" + file);
    });

    const allRunnerFiles = runnerFileNames.concat(dupRunnerFiles);
    allRunnerFiles.forEach( file => {
        fs.copyFileSync("./static/tmp/" + container + file, zipDir + "runner/" + file);
    });

    sendMsgToClient(ws, { "status": "Adding images to zip file...", "reqType": "zip" });
    console.log("DownloadID " + downloadID + ": Zipping up images...");
    var zipFile = fs.createWriteStream(zipPath);
    var archive = archiver('zip', {
        zlib: { level: 0 }
    });
    zipFile.on('close', function() {
        const fileName = "/tmp/" + zipFileName;
        console.log("DownloadID " + downloadID + ": Zip file ready, " + archive.pointer() + " total bytes");
        console.log("DownloadID " + downloadID + ": Sent " + fileName + " to Session " + ws.id);
        sendMsgToClient(ws, { "success": true, "downloadLink": fileName, "reqType": "zip" });
        return;
    });

    archive.pipe(zipFile);
    archive.directory(zipDir, false);
    cardBacks.forEach(file => {
        archive.file(__dirname + "/static/tmp/zip-cache/" + file, { name: file });
    });
    archive.file(__dirname + "/misc/README.txt", { name: "README.txt" });
    archive.finalize();
}

function noop() {}

function heartbeat() {
  this.isAlive = true;
}

const server = app.listen(port, () => {
    console.log('listening on port ' + port);
});

const wss = new WebSocket.Server({ server });
wss.on("connection", (ws) => {
    const id = sessCounter++;
    ws.id = id;
    ws.isAlive = true;
    console.log("Session " + id + " connected");
    ws.send(JSON.stringify({ "sessID": id }));
    ws.on('close', function(code) {
        console.log("Session " + id + " disconnected with " + code);
        clearInterval(ws.timer);
    });
    ws.on('pong', heartbeat);
    ws.timer = setInterval(function() {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping(noop);
    }, 1000);
    sessions[id] = ws;
});


const sequelize = new Sequelize('postgresql://alexm:Alpine1989@localhost:5432/postgres');

sequelize
  .authenticate()
  .then(() => {
    console.log('Connection has been established successfully.');
  })
  .catch(err => {
    console.error('Unable to connect to the database:', err);
  });


const Card = sequelize.define('card_test', {
    code: {
        type: Sequelize.STRING
    },
    title: {
        type: Sequelize.STRING
    },
    side: {
        type: Sequelize.STRING
    },
    quantity: {
        type: Sequelize.INTEGER
    }
});


// Card.sync({force: true}).then(() => {
//     // Table created
//     return Card.create({
//         code: '01001',
//         title: 'Reina',
//         side: 'Runner',
//         quantity: 1
//     });
// });

Card.findAll().then(cards => {
    console.log(cards)
})