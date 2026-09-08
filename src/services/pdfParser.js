const fs = require('fs');
const pdfParse = require('pdf-parse');

async function extractTextByPage(filePath) {
  const pages = [];
  const dataBuffer = fs.readFileSync(filePath);

  async function renderPage(pageData) {
    const textContent = await pageData.getTextContent();
    let text = '';
    for (let item of textContent.items) {
      text += item.str + ' ';
    }
    pages.push({ page: pageData.pageIndex + 1, text });
    return text;
  }

  const options = {
    pagerender: renderPage
  };

  await pdfParse(dataBuffer, options);
  
  // Sort pages just in case
  pages.sort((a, b) => a.page - b.page);
  return pages;
}

module.exports = { extractTextByPage };
