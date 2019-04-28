const port = process.env.PORT || 8000;
const fs = require('fs');
const fetch = require("node-fetch");
const express = require("express");
const bodyParser = require('body-parser');
const PDFDocument = require('pdfkit');
const crypto = require('crypto');
const Jimp = require('jimp');
const archiver = require('archiver');
const app = express();
app.use(express.static('static'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

function cmToPt (cm) {
	return cm * 28.3465;
}
var IDCounter = 1;
const cardwidth = 6.35;
const cardheight = 8.80;
const cardwidthPt = cmToPt(cardwidth);
const cardheightPt = cmToPt(cardheight);
const storagePath = "https://proxynexus.blob.core.windows.net/";

// setInterval(function() {
// 	const used = process.memoryUsage();
// 	for (let key in used) {
// 		console.log(`${key} ${Math.round(used[key] / 1024 / 1024 * 100) / 100} MB`);
// 	}
// }, 100);

app.post('/api/makePDF', function (req, res) {
	// unpack request
	const paperSize = req.body.paperSize;
	const quality = req.body.quality;
	const logInfo = req.body.logInfo;
	const container = ((q) => {
		switch(q) {
			case 'High':
				return 'images/';
			case 'Medium':
				return 'med-images/';
		}
	})(quality);
	const requestedImages = req.body.requestedImages;
	const downloadID = IDCounter;
	IDCounter = IDCounter + 1;
	console.log("PDF Request! DownloadID: " + downloadID + "; Papersize: " + paperSize + ", Quality: " + quality + ", " + logInfo);
	
	// Catch empty image request, and return error message
	if (requestedImages.length == 0) {
		console.error("DownloadID: " + downloadID + "; No images requested");
		res.status(200);
		var result = {}
		result.success = false;
		result.errorMsg = "No images requested";
		res.json(result);
		return;
	}

	// Catch missing image selection. Container would be null since it won't hit either case in assignment
	if (container == null) {
		console.error("DownloadID: " + downloadID + "; No image quality selected");
		res.status(200);
		var result = {}
		result.success = false;
		result.errorMsg = "No image quality selected";
		res.json(result);
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
		console.error("DownloadID: " + downloadID + "; Invalid paper size");
		res.status(200);
		var result = {}
		result.success = false;
		result.errorMsg = "Invalid paper size";
		res.json(result);
		return;
	}

	// request is good, make hash for request and pdf file name
	const requestedPDFOptions = paperSize + quality + requestedImages + logInfo;
	const hash = crypto.createHash('sha1').update(requestedPDFOptions).digest('hex');
	const pdfFileName = hash + ".pdf";
	const pdfPath = __dirname + "/static/tmp/" + pdfFileName;
	console.log("DownloadID: " + downloadID + "; PDF Name: " + pdfFileName);

	// check if request pdf was already generated, save from re-generating it
	if (fs.existsSync(pdfPath)) {
		console.log("DownloadID: " + downloadID + "; PDF already exists, don't generate");
		res.status(200);
		var result = {}
		result.success = true;
		result.fileName = "/tmp/" + pdfFileName;
		res.json(result);
		console.log("DownloadID: " + downloadID + "; Sent " + result.fileName + " to client");
		return;
	}

	const doc = new PDFDocument({
		size: paperSize,
		margins: {
			top: topMargin,
			bottom: topMargin,
			left: leftMargin,
			right: leftMargin
		  }
	});

	const opt = {
		container: container,
		quality: quality,
		doc: doc,
		downloadID: downloadID,
		pdfFileName: pdfFileName,
		requestedImages: requestedImages,
		pdfPath: pdfPath,
		topMargin: topMargin,
		leftMargin: leftMargin,
		res: res
	};
	fetchImagesForPDF(opt);
});

async function fetchImagesForPDF(opt) {	
	const container = opt.container;
	const quality = opt.quality;
	const doc = opt.doc;
	const downloadID = opt.downloadID;
	const pdfFileName = opt.pdfFileName
	const requestedImages = opt.requestedImages;
	const pdfPath = opt.pdfPath;
	const topMargin = opt.topMargin;
	const leftMargin = opt.leftMargin;
	const res = opt.res;

	// Add back side art for flippable IDs
	const imgCodes = addFlippedIds(requestedImages);

	// Strip duplicate and already downloaded image codes, to prevent downloading more than needed
	const imgFileNames = imgCodes.map(code => {return code + ".jpg"});	// used for building document later, need to maintain img count
	const uniqueImgCodes = [...new Set(imgFileNames)];
	const imgCodesToFetch = uniqueImgCodes.filter( code => {
		const imgPath = "./static/tmp/" + container + code;
		const onExistsMsg = "DownloadID: " + downloadID + "; Found cached copy of " + code + ", don't download";
		return doesNotExists(imgPath, onExistsMsg);
	});
	console.log("DownloadID: " + downloadID + "; Code list ready, Fetching images...");

	// Download image files, and wait until all are ready
	const imgPath = "./static/tmp/" + container;
	const url = storagePath + container;
	try {
		await downloadFiles(imgCodesToFetch, imgPath, url, downloadID);
	}
	catch(err) {
		console.error("DownloadID: " + downloadID + "; " + err.message);
		res.status(200);
		var result = {}
		result.success = false;
		result.errorMsg = err.message;
		res.json(result);
		return;
	}

	console.log("DownloadID: " + downloadID + "; Adding images to doc...");
	doc.pipe(fs.createWriteStream(pdfPath));
	makeFrontPage(doc, quality);
	doc.addPage();
	drawCutLines(doc, leftMargin, topMargin);
	addImages(imgFileNames, doc, container, leftMargin, topMargin);
	doc.end();

	res.status(200);
	var result = {}
	result.success = true;
	result.fileName = "/tmp/" + pdfFileName;
	res.json(result);
	console.log("DownloadID: " + downloadID + "; Sent " + result.fileName + " to client");
	return;
}

function addImages(lst, doc, container, leftMargin, topMargin) {
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
		if (colCount > 2 && i+1<lst.length) {
			colCount = 0;
			doc.addPage();
			drawCutLines(doc, leftMargin, topMargin);
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
	return imgCodes;
}

// if the path does NOT exist, return true
// if the path exists, print the message and return false
function doesNotExists(path, onExistsMsg) {
	try {
		fs.statSync(path);
		console.log(onExistsMsg);
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
function setRedPixel(orinalPath, dupPath, index, completeMsg) {
	return new Promise((resolve, reject) => {
		try {
			Jimp.read(orinalPath)
			.then(image => {
				image.scan(0, index, 1, 1, function(x, y, idx) {
						this.bitmap.data[idx] = 255;
						image.quality(90)
					}
				).write(dupPath, () => {
					console.log(completeMsg);
					resolve();
				});
			})
			.catch(err => { reject(err) });
		} catch (err) { reject(err) }
	});
}

// Download all files in fileNames to destination from the baseUrl
// Needs to be called from within a try-catch block!!
async function downloadFiles(fileNames, destination, baseUrl, downloadID) {
	const promises = fileNames.map( async fileName => {
		const filePath = destination + fileName;
		const url = baseUrl + fileName;
		const imgRes = await fetch(url)
		.then( res => {
			if (!res.ok) {
				throw new Error("Error downloading: " + fileName);
			}
			console.log("DownloadID: " + downloadID + "; Downloaded " + fileName);
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

	const imagePlacement = req.body.imagePlacement;
	const logInfo = req.body.logInfo;
	const container = ((q) => {
		switch(q) {
			case 'Scale':
				return 'scaled/';
			case 'Fit':
				return 'fitted/';
		}
	})(imagePlacement);
	const requestedImages = req.body.requestedImages;
	const downloadID = IDCounter;
	IDCounter = IDCounter + 1;
	console.log("MPC-zip Request! DownloadID: " + downloadID + "; Image Placement: " + imagePlacement + ", " + logInfo);

	// Catch empty image request, and return error message
	if (requestedImages.length == 0) {
		console.error("DownloadID: " + downloadID + "; No images requested");
		res.status(200);
		var result = {}
		result.success = false;
		result.errorMsg = "No images requested";
		res.json(result);
		return;
	}

	if (container == null) {
		console.error("DownloadID: " + downloadID + "; No image placement method selected");
		res.status(200);
		var result = {}
		result.success = false;
		result.errorMsg = "No image placement method selected";
		res.json(result);
		return;
	}

	const requestedZipOptions = imagePlacement + requestedImages + logInfo;
	const hash = crypto.createHash('sha1').update(requestedZipOptions).digest('hex');
	const zipFileName = hash + ".zip";
	const zipPath = __dirname + "/static/tmp/" + zipFileName;
	const zipDir = __dirname + "/static/tmp/zip-cache/" + hash + "/";
	console.log("DownloadID: " + downloadID + "; Zip Name: " + zipFileName);

	if (fs.existsSync(zipPath)) {
		console.log("DownloadID: " + downloadID + "; Zip already exists, don't generate");
		res.status(200);
		var result = {}
		result.success = true;
		result.fileName = "/tmp/" + zipFileName;
		res.json(result);
		console.log("DownloadID: " + downloadID + "; Sent " + result.fileName + " to client");
		return;
	}

	if (!fs.existsSync(zipDir)) {
		fs.mkdirSync(zipDir);
	}

	const opt = {
		container: container,
		downloadID: downloadID,
		requestedImages: requestedImages,
		res: res,
		zipFileName: zipFileName,
		zipDir: zipDir,
		zipPath: zipPath
	};

	fetchImagesForZip(opt);
});

async function fetchImagesForZip(opt) {

	const container = opt.container;
	const downloadID = opt.downloadID;
	const requestedImages = opt.requestedImages;
	const res = opt.res;
	const zipFileName = opt.zipFileName;
	const zipDir = opt.zipDir;
	const zipPath = opt.zipPath;
	var result = {};

	// Add back side art for flippable IDs
	const imgCodes = addFlippedIds(requestedImages);

	// buid an object of codes and counts
	imgCounts = {}
	imgCodes.forEach( code => {
		const fileName = container.replace(/\/$/, "") + "-" + code + ".jpg";
		if (fileName in imgCounts) {
			if (imgCounts[fileName] < 99) {
				imgCounts[fileName]++;
			} else {
				result.infoMsg = "Card count limited to 99 copies.";
			}
		} else {
			imgCounts[fileName] = 1;
		}
	});

	const imgFileNames = Object.keys(imgCounts);
	const imgCodesToFetch = imgFileNames.filter( file => {
		const imgPath = "./static/tmp/" + container + file;
		const onExistsMsg = "DownloadID: " + downloadID + "; Found cached copy of " + file + ", don't download";
		return doesNotExists(imgPath, onExistsMsg);
	});
	console.log("DownloadID: " + downloadID + "; Code list ready, Fetching images...");

	// Download image files, and wait until all are ready
	const imgPath = "./static/tmp/" + container;
	const url = storagePath + container;
	try {
		await downloadFiles(imgCodesToFetch, imgPath, url, downloadID);
	}
	catch(err) {
		console.error("DownloadID: " + downloadID + "; " + err.message);
		res.status(200);
		result.success = false;
		result.errorMsg = err.message;
		res.json(result);
		return;
	}

	// download back images if they're missing
	const cardBacks = ["corp-back.png", "runner-back.png"];
	const cardBacksToFetch = cardBacks.filter( file => {
		const imgPath = "./static/tmp/zip-cache/" + file;
		const onExistsMsg = "DownloadID: " + downloadID + "; Found cached copy of " + file + ", don't download";
		return doesNotExists(imgPath, onExistsMsg);
	});
	if (cardBacksToFetch.length > 0) {
		const imgPath = "./static/tmp/zip-cache/";
		const url = storagePath + "misc/";
		try {
			await downloadFiles(cardBacksToFetch, imgPath, url, downloadID);
		}
		catch(err) {
			console.error("DownloadID: " + downloadID + "; " + err.message);
			res.status(200);
			result.success = false;
			result.errorMsg = err.message;
			res.json(result);
			return;
		}
	}

	// For duplicate images, make a copy if not already cached and save the names
	var dupFileNames = [];
	var dupImgPromises = [];
	console.log("DownloadID: " + downloadID + "; Creating duplicate copies...");
	Object.keys(imgCounts).forEach( fileName => {
		const count = imgCounts[fileName];
		const splitName = fileName.split(".");
		for (var i=1; i<count; i++) {
			const dupName = splitName[0] + "-" + i + "." + splitName[1];
			const imgPath = "./static/tmp/" + container + dupName;
			const onExistsMsg = "DownloadID: " + downloadID + "; Found " + dupName + ", a cached copy of " + fileName + ", don't duplicate";
			dupFileNames.push(dupName);

			// if duplicate missing, make a copy and set the red pixel to make it unique for MPC
			if (doesNotExists(imgPath, onExistsMsg)) {
				const originalImg = "./static/tmp/" + container + fileName;
				const msg = fileName + " being copied to " + dupName;
				dupImgPromises.push(setRedPixel(originalImg, imgPath, i, msg));	// makes a copy
			}
		}	
	});
	await Promise.all(dupImgPromises);

	console.log("DownloadID: " + downloadID + "; Duplicates Ready");
	const allFileNames = imgFileNames.concat(dupFileNames);
	allFileNames.forEach( file => {			// Copy all allFileNames to zipDir
		fs.copyFileSync("./static/tmp/" + container + file, zipDir + file);
	});
	
	console.log("DownloadID: " + downloadID + "; Zipping up images...");
	var zipFile = fs.createWriteStream(zipPath);
	var archive = archiver('zip');
	zipFile.on('close', function() {
		console.log("DownloadID: " + downloadID + "; Zip file ready, " + archive.pointer() + " total bytes");
	});
	zipFile.on('end', function() {
		console.log("DownloadID: " + downloadID + "; Data has been drained");
	});

	archive.pipe(zipFile);
	archive.directory(zipDir, false);
	cardBacks.forEach(file => {
		archive.file(__dirname + "/static/tmp/zip-cache/" + file, { name: "backs/" + file });
	});
	archive.finalize();

	res.status(200);
	result.success = true;
	result.fileName = "/tmp/" + zipFileName;
	res.json(result);
	console.log("DownloadID: " + downloadID + "; Sent " + result.fileName + " to client");
	return;
}

app.listen(port, () => {
	console.log('listening on port ' + port);
});