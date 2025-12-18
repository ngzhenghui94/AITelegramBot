function escapeHtml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function applyHandPoints(text) {
    return text.replace(/^(#+) (.*)$/gm, '<b>$2</b>');
}

function applyBold(text) {
    return text.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
}

function applyItalic(text) {
    return text.replace(/(?<!\*)\*(?!\*)(?!\*\*)(.*?)(?<!\*)\*(?!\*)/g, '<i>$1</i>');
}

function applyCode(text) {
    return text.replace(/```([\w]*?)\n([\s\S]*?)```/g, '<pre lang="$1">\n$2\n</pre>');
}

function applyMonospace(text) {
    return text.replace(/(?<!`)`(?!`)(.*?)(?<!`)`(?!`)/g, '<code>$1</code>');
}

function applyLink(text) {
    return text.replace(/\[(.*?)\]\((.*?)\)/g, '<a href="$2">$1</a>');
}

function applyUnderline(text) {
    return text.replace(/__(.*?)__/g, '<u>$1</u>');
}

function applyStrikethrough(text) {
    return text.replace(/~~(.*?)~~/g, '<s>$1</s>');
}

function applyHeader(text) {
    return text.replace(/^(#{1,6})\s+(.*)/gm, '<b><u>$2</u></b>');
}

function applyExcludeCode(text) {
    const lines = text.split('\n');
    let inCodeBlock = false;

    for (let i = 0; i < lines.length; i++) {
        if (lines[i].startsWith('```')) {
            inCodeBlock = !inCodeBlock;
        }

        if (!inCodeBlock) {
            let formattedLine = lines[i];
            formattedLine = applyHeader(formattedLine);
            formattedLine = applyLink(formattedLine);
            formattedLine = applyBold(formattedLine);
            formattedLine = applyItalic(formattedLine);
            formattedLine = applyUnderline(formattedLine);
            formattedLine = applyStrikethrough(formattedLine);
            formattedLine = applyMonospace(formattedLine);
            formattedLine = applyHandPoints(formattedLine);
            lines[i] = formattedLine;
        }
    }

    return lines.join('\n');
}

export function formatMessage(text) {
    const formattedText = escapeHtml(text);
    const formattedTextWithCode = applyExcludeCode(formattedText);
    const formattedTextWithCodeBlocks = applyCode(formattedTextWithCode);
    return formattedTextWithCodeBlocks;
}
