const fs = require('fs');
const path = require('path');

async function uploadAndPoll(filename) {
  console.log(`Uploading ${filename}...`);
  const filePath = path.join(__dirname, '../samples', filename);
  
  const formData = new FormData();
  const fileBlob = new Blob([fs.readFileSync(filePath)], { type: 'application/pdf' });
  formData.append('file', fileBlob, filename);

  const res = await fetch('http://localhost:3000/documents/upload', {
    method: 'POST',
    body: formData
  });
  
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Upload failed for ${filename}: ${err}`);
  }

  const { documentId } = await res.json();
  console.log(`Uploaded ${filename} as document ${documentId}. Polling for completion...`);

  return new Promise((resolve, reject) => {
    const interval = setInterval(async () => {
      try {
        const pollRes = await fetch(`http://localhost:3000/documents/${documentId}`);
        const doc = await pollRes.json();
        
        if (doc.status === 'done') {
          clearInterval(interval);
          console.log(`Document ${documentId} (${filename}) is done.`);
          resolve();
        } else if (doc.status === 'failed') {
          clearInterval(interval);
          reject(new Error(`Document ${documentId} processing failed.`));
        }
      } catch (e) {
        // network issue, keep polling
      }
    }, 2000);
  });
}

async function run() {
  const files = [
    '01-delhivery-prospectus-2022-excerpt.pdf',
    '02-delhivery-annual-report-fy24-excerpt.pdf',
    '03-delhivery-q4-fy24-earnings-presentation.pdf'
  ];

  for (const f of files) {
    await uploadAndPoll(f);
  }
  console.log("All done.");
}

run().catch(console.error);
