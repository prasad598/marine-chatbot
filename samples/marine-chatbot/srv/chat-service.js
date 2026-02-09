'use strict';

const cds = require('@sap/cds');
const marine_util = require('./marine-util');
const { handleMemoryBeforeRagCall, handleMemoryAfterRagCall } = require('./memory-helper');

const PROJECT_NAME = 'MARINE_USECASE';

// ---- CONFIG ----
const tableName = 'SAP_TISCE_DEMO_DOCUMENTCHUNK';
const embeddingColumn = 'EMBEDDING';
const contentColumn = 'TEXT_CHUNK';
const conversationContextCache = new Map();
const CONTEXT_CACHE_TTL_MS = 30 * 60 * 1000;
const PAGE_SIZE_DEFAULT = 20;

// ---------------- SYSTEM PROMPT (classifier) ----------------
const systemPrompt = `Classify the user question into one of the following categories: document-status, document-search, status-clarification, or generic-query.

Return a JSON object following the examples below.

If the user requests the status of a purchase order, purchase requisition, or invoice, return:
{
  "category": "document-status",
  "docType": "PO | PR | INV",
  "documentNumbers": ["<document numbers from the user, digits only>"]
}

If the user requests the status of multiple documents of the same type, include all numbers in the array:
{
  "category": "document-status",
  "docType": "PO | PR | INV",
  "documentNumbers": ["3020380601", "3020380602"]
}

If the user asks to search for documents by filters (date ranges, creator, approver, payment status, etc.), return:
{
  "category": "document-search",
  "filters": {
    "purchaseOrder": "<PO number(s), comma-separated>",
    "purchaseRequisition": "<PR number(s), comma-separated>",
    "invoice": "<invoice number(s), comma-separated>",
    "vendor": "<vendor id>",
    "dateFrom": "01.01.2025",
    "dateTo": "31.03.2025",
    "approveFromDate": "01.08.2025",
    "approveToDate": "31.12.2025",
    "dueFromDate": "01.08.2025",
    "dueToDate": "31.12.2025",
    "docType": "PO | PR | INV",
    "creator": "<user id or 'me'>",
    "approver": "<user id or 'me'>",
    "paymentStatus": "<PAID | Not yet Paid | PARTIAL | etc>",
    "costCenter": "<cost center>",
    "wbs": "<wbs>",
    "glAccount": "<gl account>",
    "poStatus": "APPROVED | PENDING | DELETED",
    "prStatus": "RELEASED | PENDING | REJECTED | DELETED",
    "seStatus": "RELEASED | PENDING",
    "saStatus": "ACCEPTED | PENDING",
    "reportType": "TOP_VENDOR | TOP_PO | SEARCH_DESC | PR_APPROVED | PR_PENDING | INVOICE_AGING | INVOICE_OVERDUE | PR_OVERDUE | 3WAY_PENDING | PO_OVERDUE",
    "purchasingOrg": "<purchasing organization>",
    "topN": 20,
    "minValue": 1000,
    "description": "<keywords, comma-separated>",
    "overdueDays": 90,
    "top": 10,
    "skip": 0,
    "count": true
  }
}

Payment status guidance for search filters:
- If the user mentions payment completed/paid, set paymentStatus to "PAID".
- If the user mentions payment due/outstanding/not paid, set paymentStatus to "Not yet Paid".
- Use the exact value strings above when setting paymentStatus.
- For overdue report requests (INVOICE_OVERDUE, PR_OVERDUE, or PO_OVERDUE), do not set paymentStatus; use reportType with overdueDays only.

Examples for search filters:
- "How many POs approved between 01/08/2025 to 31/12/2025" ->
  { "docType": "PO", "approveFromDate": "01.08.2025", "approveToDate": "31.12.2025", "count": true }
- "List all PRs pending for approval" ->
  { "docType": "PR", "prStatus": "PENDING" }
- "List all invoices overdue for payment by more than 90 days" ->
  { "reportType": "INVOICE_OVERDUE", "overdueDays": 90 }
- "List all POs overdue more than 90 days" ->
  { "reportType": "PO_OVERDUE", "overdueDays": 90, "docType": "PO" }
- "List all PRs overdue for payment by more than 90 days" ->
  { "reportType": "PR_OVERDUE", "overdueDays": 90, "docType": "PR" }
- "List POs issued between 25.01.2025 and 28.01.2025" ->
  { "docType": "PO", "dateFrom": "25.01.2025", "dateTo": "28.01.2025" }
- "POs approved between 28.01.2026 and 28.02.2026" ->
  { "docType": "PO", "approveFromDate": "28.01.2026", "approveToDate": "28.02.2026" }
- "Count documents due between 01.08.2025 and 31.12.2025" ->
  { "dueFromDate": "01.08.2025", "dueToDate": "31.12.2025", "count": true }
- "Get first 100 POs" ->
  { "docType": "PO", "dateFrom": "01.01.2025", "dateTo": "31.12.2025", "top": 100 }
- "Get next 100 POs" ->
  { "docType": "PO", "dateFrom": "01.01.2025", "dateTo": "31.12.2025", "top": 100, "skip": 100 }
- "Count only (no data)" ->
  { "docType": "PO", "dateFrom": "01.01.2025", "dateTo": "31.12.2025", "count": true }

Query formation guidance:
- Use DocType=PO/PR/INV when the user specifies purchase orders, requisitions, or invoices.
- Use Vendor, CostCenter, WBS, GLAccount, Creator, Approver for the corresponding filters.
- Use DateFrom/DateTo for issuance dates, ApproveFromDate/ApproveToDate for approval dates, DueFromDate/DueToDate for due dates.
- Use POStatus/PRStatus for approval/release status, SEStatus for service entry status, SAStatus for service acceptance status.
- Use MinValue for value thresholds and TopN for top-N reports.
- Use ReportType for special reports (TOP_VENDOR, TOP_PO, SEARCH_DESC, PR_APPROVED, PR_PENDING, INVOICE_AGING, INVOICE_OVERDUE, PR_OVERDUE, 3WAY_PENDING, PO_OVERDUE).
- For overdue reports, use ReportType + OverdueDays and do not include PaymentStatus.
- Use top/skip for pagination and count=true for count-only requests.

For all other questions (including queries answered from the embedding/policy documents), return:
{
  "category": "generic-query"
}

If the user asks for a status update but does not clearly specify whether it concerns a purchase order, invoice, or purchase requisition, return:
{
  "category": "status-clarification",
  "referenceNumber": "<number provided by the user if any, digits only>"
}

If the user asks for related PO/PR details for an invoice (including follow-ups like "above invoice" or "previous invoice"),
return document-status with docType INV and any invoice number provided (or an empty array if not provided).

Rules:
1. Always provide the number(s) if mentioned; otherwise return an empty string or empty array for that field.
2. Prefer the number explicitly associated with the document type mentioned by the user.
3. If the request is ambiguous between purchase order and invoice, choose INV when the user mentions invoice terms.
4. If the user asks for a status but neither the document type nor the number is clear, return status-clarification with the provided number if any.
5. Do not invent numbers.
`;

// ---------------- CATEGORY PROMPTS ----------------
const genericRequestPrompt =
  'You are a marine procurement assistant. Answer the user question using only the provided context from marine policy or reference documents (delimited by triple backticks). Keep the tone formal, concise, and clearly formatted.';

const purchaseOrderStatusPrompt = `You are a marine procurement assistant. Use the provided purchase order status context, delimited by triple backticks, to summarize the status for the user.
- Highlight the purchase order number, each item, the status, and deletion indicators.
- If related purchase requisitions are present, summarize them as well.
- If the service response is empty or unsuccessful, state that you cannot find status for the provided purchase order.
- Keep the answer neatly formatted with short headings and bullet points.`;

const purchaseRequisitionStatusPrompt = `You are a marine procurement assistant. Use the provided purchase requisition status context, delimited by triple backticks, to summarize the status for the user.
- Show the purchase requisition number, release status, deletion indicators, and any linked purchase orders.
- If the service response is empty or unsuccessful, state that you cannot find status for the provided purchase requisition.
- Keep the answer neatly formatted with short headings and bullet points.`;

const invoiceStatusPrompt = `You are a marine procurement assistant. Use the provided invoice status context, delimited by triple backticks, to summarize the invoice details for the given invoice.
- Include the invoice number, value, key dates, and invoice status.
- If the service response is empty or unsuccessful, state that you cannot find status for the provided invoice or purchase order.
- Keep the answer neatly formatted with short headings and bullet points.`;

const basePrompts = {
  'purchase-order-status': purchaseOrderStatusPrompt,
  'invoice-status': invoiceStatusPrompt,
  'purchase-requisition-status': purchaseRequisitionStatusPrompt,
  'document-status': purchaseOrderStatusPrompt,
  'document-search': genericRequestPrompt,
  'status-clarification': genericRequestPrompt,
  'generic-query': genericRequestPrompt
};

// ---------------- Formatting helpers ----------------
function pickFirst(obj, keys, fallback = '') {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return v;
  }
  return fallback;
}

function normBoolText(v) {
  if (v === true) return 'Yes';
  if (v === false) return 'No';
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (['true', 'x', 'yes', 'y'].includes(s)) return 'Yes';
    if (['false', 'no', 'n'].includes(s)) return 'No';
  }
  if (v === '' || v == null) return 'No';
  return String(v);
}

function joinLine(label, value) {
  const val = value == null ? '' : String(value).trim();
  return `${label}: ${val || 'N/A'}`;
}

function formatPoItemDetails(lines, it, idx, fallbackPo) {
  const poNo = pickFirst(it, ['PO Number', 'ebeln', 'poNumber'], fallbackPo);
  const poItem = pickFirst(it, ['PO Item', 'ebelp', 'poItem']);
  const status = pickFirst(it, ['PO Status', 'poStatus']);
  const delInd = pickFirst(it, ['Del. Indicator', 'loekz'], '');
  const deleted = normBoolText(pickFirst(it, ['PO Deleted', 'poDeleted'], ''));
  const prNo = pickFirst(it, ['PR Number', 'banfn', 'prNumber'], '');
  const prItem = pickFirst(it, ['PR Item', 'bnfpo', 'prItem'], '');
  const materialNo = pickFirst(it, ['Material Number', 'matnr', 'materialNumber'], '');
  const materialDesc = pickFirst(it, ['Material Desc', 'txz01', 'materialDescription'], '');
  const quantity = pickFirst(it, ['Quantity', 'menge', 'quantity'], '');
  const uom = pickFirst(it, ['UOM', 'meins', 'uom'], '');
  const netValue = pickFirst(it, ['Net Value', 'netValue'], '');
  const currency = pickFirst(it, ['Currency', 'waers', 'currency'], '');
  const poDate = pickFirst(it, ['PO Date', 'bedat', 'poDate'], '');
  const vendorCode = pickFirst(it, ['Vendor Code', 'lifnr', 'vendorCode'], '');
  const vendorName = pickFirst(it, ['Vendor Name', 'name1', 'vendorName'], '');
  const poCreatorId = pickFirst(it, ['PO Creator ID', 'poCreatorId'], '');
  const poCreatorName = pickFirst(it, ['PO Creator', 'poCreatorName'], '');
  const poApproverId = pickFirst(it, ['PO Approver ID', 'poApproverId'], '');
  const poApproverName = pickFirst(it, ['PO Approver', 'poApproverName'], '');
  const poApproveDate = pickFirst(it, ['PO Approve Date', 'poApproveDate'], '');
  const wbsElement = pickFirst(it, ['WBS Element', 'wbsElement'], '');
  const costCenter = pickFirst(it, ['Cost Center', 'kostl', 'costCenter'], '');
  const glAccount = pickFirst(it, ['GL Account', 'sakto', 'glAccount'], '');

  lines.push(`${idx + 1}.`);
  lines.push(joinLine('PO Number', poNo));
  lines.push(joinLine('PO Item', poItem));
  lines.push(joinLine('Status', status));
  lines.push(joinLine('Deleted', deleted));
  if (delInd) lines.push(joinLine('Deletion Indicator', delInd));
  if (prNo) lines.push(joinLine('Linked PR', prItem ? `${prNo} / ${prItem}` : prNo));
  if (materialNo) lines.push(joinLine('Material Number', materialNo));
  if (materialDesc) lines.push(joinLine('Material Description', materialDesc));
  if (quantity) lines.push(joinLine('Quantity', quantity));
  if (uom) lines.push(joinLine('UOM', uom));
  if (netValue) lines.push(joinLine('Net Value', netValue));
  if (currency) lines.push(joinLine('Currency', currency));
  if (poDate) lines.push(joinLine('PO Date', poDate));
  if (vendorCode) lines.push(joinLine('Vendor Code', vendorCode));
  if (vendorName) lines.push(joinLine('Vendor Name', vendorName));
  if (poCreatorId) lines.push(joinLine('PO Creator ID', poCreatorId));
  if (poCreatorName) lines.push(joinLine('PO Creator Name', poCreatorName));
  if (poApproverId) lines.push(joinLine('PO Approver ID', poApproverId));
  if (poApproverName) lines.push(joinLine('PO Approver Name', poApproverName));
  if (poApproveDate) lines.push(joinLine('PO Approve Date', poApproveDate));
  if (wbsElement) lines.push(joinLine('WBS Element', wbsElement));
  if (costCenter) lines.push(joinLine('Cost Center', costCenter));
  if (glAccount) lines.push(joinLine('GL Account', glAccount));
  lines.push('');
}

function formatPrItemDetails(lines, it, idx, fallbackPr) {
  const prNo = pickFirst(it, ['PR Number', 'banfn', 'prNumber'], fallbackPr);
  const prItem = pickFirst(it, ['PR Item', 'bnfpo', 'prItem']);
  const status = pickFirst(it, ['PR Status', 'prStatus']);
  const releaseInd = pickFirst(it, ['Release ind.', 'frgkz', 'releaseIndicator'], '');
  const releaseStatus = pickFirst(it, ['Release Status', 'releaseStatus'], '');
  const prReleaseDate = pickFirst(it, ['PR Release Date', 'prReleaseDate'], '');
  const prDate = pickFirst(it, ['PR Date', 'prDate'], '');
  const prCreatorId = pickFirst(it, ['PR Creator ID', 'prCreatorId'], '');
  const prCreatorName = pickFirst(it, ['PR Creator', 'prCreatorName'], '');
  const prRequestorId = pickFirst(it, ['PR Requestor ID', 'prRequestorId'], '');
  const prRequestorName = pickFirst(it, ['PR Requestor', 'prRequestorName'], '');
  const prApproverId = pickFirst(it, ['PR Approver ID', 'prApproverId'], '');
  const prApproverName = pickFirst(it, ['PR Approver', 'prApproverName'], '');
  const prApproveDate = pickFirst(it, ['PR Approve Date', 'prApproveDate'], '');
  const deleted = normBoolText(pickFirst(it, ['PR Deleted', 'prDeleted'], ''));
  const rejected = normBoolText(pickFirst(it, ['PR Rejected', 'prRejected'], ''));
  const delInd = pickFirst(it, ['Del. Indicator', 'loekz'], '');
  const linkedPo = pickFirst(it, ['PO Number', 'ebeln', 'poNumber'], '');
  const linkedPoItem = pickFirst(it, ['PO Item', 'ebelp', 'poItem'], '');

  lines.push(`${idx + 1}.`);
  lines.push(joinLine('PR Number', prNo));
  lines.push(joinLine('PR Item', prItem));
  lines.push(joinLine('Status', status));
  if (releaseInd) lines.push(joinLine('Release Indicator', releaseInd));
  if (releaseStatus) lines.push(joinLine('Release Status', releaseStatus));
  if (prReleaseDate) lines.push(joinLine('Release Date', prReleaseDate));
  if (prDate) lines.push(joinLine('PR Date', prDate));
  if (prCreatorId) lines.push(joinLine('PR Creator ID', prCreatorId));
  if (prCreatorName) lines.push(joinLine('PR Creator Name', prCreatorName));
  if (prRequestorId) lines.push(joinLine('PR Requestor ID', prRequestorId));
  if (prRequestorName) lines.push(joinLine('PR Requestor Name', prRequestorName));
  if (prApproverId) lines.push(joinLine('PR Approver ID', prApproverId));
  if (prApproverName) lines.push(joinLine('PR Approver Name', prApproverName));
  if (prApproveDate) lines.push(joinLine('PR Approve Date', prApproveDate));
  lines.push(joinLine('Deleted', deleted));
  lines.push(joinLine('Rejected', rejected));
  if (delInd) lines.push(joinLine('Deletion Indicator', delInd));
  if (linkedPo) lines.push(joinLine('Linked PO', linkedPoItem ? `${linkedPo} / ${linkedPoItem}` : linkedPo));
  lines.push('');
}

function formatInvoiceItemDetails(lines, it, idx) {
  const invoiceNo = pickFirst(it, ['invoiceNo', 'Invoice No', 'Invoice Number', 'invoiceNumber', 'invoiceDocNumber']);
  const fiscalYear = pickFirst(it, ['Fiscal Year', 'fiscalYear'], '');
  const invoiceRef = pickFirst(it, ['Invoice Reference', 'invoiceReference'], '');
  const vendorCode = pickFirst(it, ['Vendor Code', 'vendorCode', 'lifnr'], '');
  const vendorName = pickFirst(it, ['Vendor Name', 'vendorName', 'name1'], '');
  const value = pickFirst(it, ['invoiceValue', 'Invoice Value', 'Invoice Amount', 'grossAmount', 'dmbtr'], '');
  const taxAmount = pickFirst(it, ['Tax Amount', 'taxAmount', 'mwsts'], '');
  const netAmount = pickFirst(it, ['Net Amount', 'netAmount', 'wrbtr'], '');
  const currency = pickFirst(it, ['Currency', 'currency', 'waers'], '');
  const status = pickFirst(it, ['paymentStatus', 'Payment Status', 'livStatus', 'LIV Status', 'Invoice Status'], '');
  const docDate = pickFirst(it, ['invoiceDocDate', 'Doc Date', 'Document Date', 'bldat'], '');
  const postDate = pickFirst(it, ['invoicePostDate', 'Posting Date', 'budat'], '');
  const paymentDueOn = pickFirst(it, ['paymentDueOn', 'Payment Due On', 'Payment Due Date', 'paymentDueDate', 'netdt'], '');
  const clearingDoc = pickFirst(it, ['Clearing Document', 'clearingDocument', 'augbl'], '');
  const clearingDate = pickFirst(it, ['clearingDate', 'Clearing Date', 'augdt'], '');
  const paidAmount = pickFirst(it, ['Paid Amount', 'paidAmount'], '');
  const invCreatorId = pickFirst(it, ['Invoice Creator ID', 'invCreatorId'], '');
  const invCreatorName = pickFirst(it, ['Invoice Creator', 'invCreatorName'], '');
  const invApproverId = pickFirst(it, ['Invoice Approver ID', 'invApproverId'], '');
  const invApproverName = pickFirst(it, ['Invoice Approver', 'invApproverName'], '');
  const invApproveDate = pickFirst(it, ['Invoice Approve Date', 'invApproveDate'], '');
  const lineItems = Array.isArray(it?.lineItems) ? it.lineItems : [];

  lines.push(`${idx + 1}.`);
  lines.push(joinLine('Invoice Number', invoiceNo));
  if (fiscalYear) lines.push(joinLine('Fiscal Year', fiscalYear));
  if (invoiceRef) lines.push(joinLine('Invoice Reference', invoiceRef));
  if (vendorCode) lines.push(joinLine('Vendor Code', vendorCode));
  if (vendorName) lines.push(joinLine('Vendor Name', vendorName));
  if (value) lines.push(joinLine('Invoice Value', value));
  if (taxAmount) lines.push(joinLine('Tax Amount', taxAmount));
  if (netAmount) lines.push(joinLine('Net Amount', netAmount));
  if (currency) lines.push(joinLine('Currency', currency));
  if (status) lines.push(joinLine('Status', status));
  if (docDate) lines.push(joinLine('Document Date', docDate));
  if (postDate) lines.push(joinLine('Posting Date', postDate));
  if (paymentDueOn) lines.push(joinLine('Payment Due On', paymentDueOn));
  if (clearingDoc) lines.push(joinLine('Clearing Document', clearingDoc));
  if (clearingDate) lines.push(joinLine('Clearing Date', clearingDate));
  if (paidAmount) lines.push(joinLine('Paid Amount', paidAmount));
  if (invCreatorId) lines.push(joinLine('Invoice Creator ID', invCreatorId));
  if (invCreatorName) lines.push(joinLine('Invoice Creator Name', invCreatorName));
  if (invApproverId) lines.push(joinLine('Invoice Approver ID', invApproverId));
  if (invApproverName) lines.push(joinLine('Invoice Approver Name', invApproverName));
  if (invApproveDate) lines.push(joinLine('Invoice Approve Date', invApproveDate));

  if (lineItems.length) {
    lines.push('Line Items:');
    lineItems.forEach((line, lineIdx) => {
      const lineItemNumber = pickFirst(line, ['lineItemNumber', 'Line Item Number']);
      const poNumber = pickFirst(line, ['poNumber', 'PO Number']);
      const poItem = pickFirst(line, ['poItem', 'PO Item']);
      const amount = pickFirst(line, ['lineItemAmount', 'Line Item Amount']);
      lines.push(`  ${lineIdx + 1}.`);
      lines.push(`  ${joinLine('Line Item', lineItemNumber)}`);
      lines.push(`  ${joinLine('PO Number', poNumber)}`);
      lines.push(`  ${joinLine('PO Item', poItem)}`);
      lines.push(`  ${joinLine('Amount', amount)}`);
    });
  }

  lines.push('');
}

function formatPoStatusNice(purchaseOrder, resp) {
  const poItems = Array.isArray(resp?.poItems) ? resp.poItems : [];
  const prItems = Array.isArray(resp?.prItems) ? resp.prItems : [];
  const invoiceItems = Array.isArray(resp?.invoiceItems) ? resp.invoiceItems : [];

  const lines = [];
  lines.push(`Purchase Order Status (PO: ${purchaseOrder})`);
  lines.push('');

  lines.push('Purchase Order Items:');
  if (!poItems.length) {
    lines.push('No PO items returned.');
  } else {
    poItems.forEach((it, idx) => {
      formatPoItemDetails(lines, it, idx, purchaseOrder);
    });
  }

  lines.push('Related Purchase Requisitions:');
  if (!prItems.length) {
    lines.push('No related PR items returned.');
  } else {
    prItems.forEach((it, idx) => {
      formatPrItemDetails(lines, it, idx);
    });
  }

  lines.push('Related Invoices:');
  if (!invoiceItems.length) {
    lines.push('No related invoice items returned.');
  } else {
    invoiceItems.forEach((it, idx) => {
      formatInvoiceItemDetails(lines, it, idx);
    });
  }

  return lines.join('\n');
}

function formatPrStatusNice(purchaseRequisition, resp) {
  const poItems = Array.isArray(resp?.poItems) ? resp.poItems : [];
  const prItems = Array.isArray(resp?.prItems) ? resp.prItems : [];
  const invoiceItems = Array.isArray(resp?.invoiceItems) ? resp.invoiceItems : [];

  const lines = [];
  lines.push(`Purchase Requisition Status (PR: ${purchaseRequisition})`);
  lines.push('');

  lines.push('Purchase Requisition Items:');
  if (!prItems.length) {
    lines.push('No PR items returned.');
  } else {
    prItems.forEach((it, idx) => {
      formatPrItemDetails(lines, it, idx, purchaseRequisition);
    });
  }

  lines.push('Related Purchase Orders:');
  if (!poItems.length) {
    lines.push('No related PO items returned.');
  } else {
    poItems.forEach((it, idx) => {
      formatPoItemDetails(lines, it, idx);
    });
  }

  lines.push('Related Invoices:');
  if (!invoiceItems.length) {
    lines.push('No related invoice items returned.');
  } else {
    invoiceItems.forEach((it, idx) => {
      formatInvoiceItemDetails(lines, it, idx);
    });
  }

  return lines.join('\n');
}

function formatInvoiceStatusNice(purchaseOrder, resp) {
  const items = Array.isArray(resp?.invoiceItems) ? resp.invoiceItems : [];
  const poItems = Array.isArray(resp?.poItems) ? resp.poItems : [];
  const prItems = Array.isArray(resp?.prItems) ? resp.prItems : [];
  const lines = [];
  lines.push(`Invoice Status (Invoice: ${purchaseOrder})`);
  lines.push('');

  if (!items.length) {
    lines.push('No invoice items returned.');
    return lines.join('\n');
  }

  lines.push('Invoice Items:');
  items.forEach((it, idx) => {
    formatInvoiceItemDetails(lines, it, idx);
  });

  if (poItems.length) {
    lines.push('Related Purchase Orders:');
    poItems.forEach((it, idx) => {
      formatPoItemDetails(lines, it, idx);
    });
  }

  if (prItems.length) {
    lines.push('Related Purchase Requisitions:');
    prItems.forEach((it, idx) => {
      formatPrItemDetails(lines, it, idx);
    });
  }

  return lines.join('\n');
}

function normalizeDocType(rawType) {
  if (!rawType) return '';
  const value = String(rawType).trim().toLowerCase();
  if (['po', 'purchaseorder', 'purchase order'].includes(value)) return 'PO';
  if (['pr', 'purchaserequisition', 'purchase requisition'].includes(value)) return 'PR';
  if (['inv', 'invoice'].includes(value)) return 'INV';
  return '';
}

function normalizeCountFlag(value) {
  if (value === true) return true;
  if (value === false || value == null) return false;
  const normalized = String(value).trim().toLowerCase();
  return ['true', 'yes', 'y', '1', 'x', 'count'].includes(normalized);
}

function normalizeNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function normalizeUpperValue(value) {
  if (value === undefined || value === null || value === '') return undefined;
  return String(value).trim().toUpperCase();
}

function normalizeUserFilter(value, userId) {
  if (!value) return value;
  const normalized = String(value).trim().toLowerCase();
  if (['me', 'my', 'mine', 'myself'].includes(normalized)) {
    return userId;
  }
  return value;
}

function normalizePaymentStatus(value, userQuery) {
  const candidate = value ? String(value).trim().toLowerCase() : '';
  const query = userQuery ? String(userQuery).trim().toLowerCase() : '';

  if (!candidate && !query) return undefined;

  if (/(payment\s+)?(due|outstanding|not\s+paid|not\s+yet\s+paid|unpaid)\b/.test(query)) {
    return 'Not yet Paid';
  }
  if (/(payment\s+)?(complete|completed|paid)\b/.test(query)) {
    return 'PAID';
  }
  if (/(partial|partially\s+paid)\b/.test(query)) {
    return 'PARTIAL';
  }

  if (/(payment\s+)?(due|outstanding|not\s+paid|not\s+yet\s+paid|unpaid)\b/.test(candidate)) {
    return 'Not yet Paid';
  }
  if (/(payment\s+)?(complete|completed|paid)\b/.test(candidate)) {
    return 'PAID';
  }
  if (/(partial|partially\s+paid)\b/.test(candidate)) {
    return 'PARTIAL';
  }

  return value ? String(value).trim() : undefined;
}

function isOverdueReportType(reportType) {
  if (!reportType) return false;
  const normalized = String(reportType).trim().toUpperCase();
  return ['INVOICE_OVERDUE', 'PR_OVERDUE', 'PO_OVERDUE'].includes(normalized);
}

function formatOverdueReportPayload(resp, filters = {}) {
  const reportType = normalizeUpperValue(filters?.reportType || resp?.raw?.reportType);
  if (!['INVOICE_OVERDUE', 'PR_OVERDUE', 'PO_OVERDUE'].includes(reportType)) {
    return null;
  }

  const raw = resp?.raw && typeof resp.raw === 'object' ? resp.raw : {};
  const fallbackItems = {
    INVOICE_OVERDUE: Array.isArray(resp?.invoiceItems) ? resp.invoiceItems : [],
    PR_OVERDUE: Array.isArray(resp?.prItems) ? resp.prItems : [],
    PO_OVERDUE: Array.isArray(resp?.poItems) ? resp.poItems : []
  };
  const overdueArrayMap = {
    INVOICE_OVERDUE: ['overdueInvoices', 'invoiceItems', 'invoices'],
    PR_OVERDUE: ['overduePRs', 'overduePurchaseRequisitions', 'prItems', 'purchaseRequisitions'],
    PO_OVERDUE: ['overduePOs', 'overduePurchaseOrders', 'poItems', 'purchaseOrders']
  };

  const overdueItems =
    overdueArrayMap[reportType]
      .map((key) => raw?.[key])
      .find((value) => Array.isArray(value)) || fallbackItems[reportType];

  const totalsByType = {
    INVOICE_OVERDUE: Number.isFinite(raw?.totalOverdue)
      ? raw.totalOverdue
      : Number.isFinite(resp?.totalCount)
        ? resp.totalCount
        : overdueItems.length,
    PR_OVERDUE: Number.isFinite(raw?.totalOverdue)
      ? raw.totalOverdue
      : Number.isFinite(resp?.totalCount)
        ? resp.totalCount
        : overdueItems.length,
    PO_OVERDUE: Number.isFinite(raw?.totalOverdue)
      ? raw.totalOverdue
      : Number.isFinite(resp?.totalCount)
        ? resp.totalCount
        : overdueItems.length
  };

  const lines = [];

  if (reportType === 'INVOICE_OVERDUE') {
    const summaryLine = buildListRetrievalSummary({
      totalCount: totalsByType[reportType],
      shownCount: overdueItems.length,
      pageSize: Number.isFinite(resp?.resultCount) ? resp.resultCount : overdueItems.length || PAGE_SIZE_DEFAULT,
      skip: Number.isFinite(raw?.skip) ? raw.skip : 0,
      label: 'invoices'
    });
    if (summaryLine) lines.push(summaryLine);
    if (raw?.totalAmount !== undefined && raw?.totalAmount !== null) {
      lines.push(joinLine('Total Amount', raw.totalAmount));
    }
    if (raw?.currency) {
      lines.push(joinLine('Currency', raw.currency));
    }
    lines.push('');

    if (!overdueItems.length) {
      lines.push('No overdue invoices found for the selected filters.');
      return lines.join('\n');
    }

    lines.push('Invoice Items:');
    overdueItems.forEach((it, idx) => {
      formatInvoiceItemDetails(lines, it, idx);
      const dueDate = pickFirst(it, ['dueDate', 'paymentDueOn', 'Payment Due On', 'Payment Due Date'], '');
      const daysOverdue = pickFirst(it, ['daysOverdue', 'overdueDays'], '');
      if (dueDate || daysOverdue) {
        if (lines[lines.length - 1] === '') lines.pop();
        if (dueDate) lines.push(joinLine('Due Date', dueDate));
        if (daysOverdue) lines.push(joinLine('Days Overdue', daysOverdue));
        lines.push('');
      }
    });

    return lines.join('\n');
  }

  if (reportType === 'PR_OVERDUE') {
    const summaryLine = buildListRetrievalSummary({
      totalCount: totalsByType[reportType],
      shownCount: overdueItems.length,
      pageSize: Number.isFinite(resp?.resultCount) ? resp.resultCount : overdueItems.length || PAGE_SIZE_DEFAULT,
      skip: Number.isFinite(raw?.skip) ? raw.skip : 0,
      label: 'purchase requisitions'
    });
    if (summaryLine) lines.push(summaryLine);
    lines.push('');

    if (!overdueItems.length) {
      lines.push('No overdue purchase requisitions found for the selected filters.');
      return lines.join('\n');
    }

    lines.push('Purchase Requisition Items:');
    overdueItems.forEach((it, idx) => {
      formatPrItemDetails(lines, it, idx);
      const daysOverdue = pickFirst(it, ['daysOverdue', 'overdueDays'], '');
      if (daysOverdue) {
        if (lines[lines.length - 1] === '') lines.pop();
        lines.push(joinLine('Days Overdue', daysOverdue));
        lines.push('');
      }
    });

    return lines.join('\n');
  }

  const summaryLine = buildListRetrievalSummary({
    totalCount: totalsByType[reportType],
    shownCount: overdueItems.length,
    pageSize: Number.isFinite(resp?.resultCount) ? resp.resultCount : overdueItems.length || PAGE_SIZE_DEFAULT,
    skip: Number.isFinite(raw?.skip) ? raw.skip : 0,
    label: 'purchase orders'
  });
  if (summaryLine) lines.push(summaryLine);
  lines.push('');

  if (!overdueItems.length) {
    lines.push('No overdue purchase orders found for the selected filters.');
    return lines.join('\n');
  }

  lines.push('Purchase Order Items:');
  overdueItems.forEach((it, idx) => {
    formatPoItemDetails(lines, it, idx);
    const daysOverdue = pickFirst(it, ['daysOverdue', 'overdueDays'], '');
    if (daysOverdue) {
      if (lines[lines.length - 1] === '') lines.pop();
      lines.push(joinLine('Days Overdue', daysOverdue));
      lines.push('');
    }
  });

  return lines.join('\n');
}

function normalizeDocNumbers(rawNumbers) {
  if (!rawNumbers) return [];
  const normalizeToken = (value) =>
    `${value}`
      .trim()
      .replace(/^['"`]+|['"`]+$/g, '')
      .replace(/[.,;:!?]+$/g, '')
      .trim();

  const splitTokens = (value) =>
    `${value}`
      .split(/\s*(?:,|;|\n|\r|\t|\band\b)\s*/i)
      .map(normalizeToken)
      .filter((token) => /[a-z0-9]/i.test(token));

  if (Array.isArray(rawNumbers)) {
    return rawNumbers.flatMap((entry) => splitTokens(entry));
  }

  return splitTokens(rawNumbers);
}

function parsePaginationRequest(userQuery) {
  if (!userQuery) return null;
  const text = `${userQuery}`.toLowerCase();
  const nextMatch = text.match(/\bnext\s+(\d+)\b/);
  if (nextMatch) {
    const size = Number(nextMatch[1]);
    return Number.isFinite(size) && size > 0 ? { isNextPage: true, pageSize: size } : null;
  }
  if (/\b(next|continue|show\s+more|another\s+page)\b/.test(text)) {
    return { isNextPage: true, pageSize: PAGE_SIZE_DEFAULT };
  }
  return null;
}

function hasFollowUpHint(userQuery) {
  if (!userQuery) return false;
  const text = `${userQuery}`.toLowerCase();
  return /\b(above|previous|earlier|same|that|those|last|related|follow[-\s]?up|again|what about)\b/.test(text);
}

function isListFollowUp(userQuery) {
  if (!userQuery) return false;
  const text = `${userQuery}`.toLowerCase();
  return /\b(list|show|display|see|provide)\b.*\b(them|those|these|all|results|entries)\b/.test(text);
}

function hasSearchFilters(filters = {}) {
  return Object.values(filters).some(
    (value) => value !== undefined && value !== null && value !== '' && value !== false
  );
}

function extractSearchFilters(determinationJson = {}) {
  if (determinationJson?.filters && typeof determinationJson.filters === 'object') {
    return determinationJson.filters;
  }

  const allowedFilterKeys = [
    'purchaseOrder',
    'purchaseRequisition',
    'invoice',
    'vendor',
    'dateFrom',
    'dateTo',
    'approveFromDate',
    'approveToDate',
    'dueFromDate',
    'dueToDate',
    'docType',
    'creator',
    'approver',
    'paymentStatus',
    'costCenter',
    'wbs',
    'glAccount',
    'poStatus',
    'prStatus',
    'seStatus',
    'saStatus',
    'reportType',
    'purchasingOrg',
    'topN',
    'minValue',
    'description',
    'overdueDays',
    'top',
    'skip',
    'count'
  ];

  const flattenedFilters = {};
  for (const key of allowedFilterKeys) {
    if (determinationJson?.[key] !== undefined) {
      flattenedFilters[key] = determinationJson[key];
    }
  }

  return flattenedFilters;
}

function getCachedConversationContext(conversationId) {
  if (!conversationId) return { docType: '', documentNumbers: [] };
  const cached = conversationContextCache.get(conversationId);
  if (!cached) {
    return { docType: '', documentNumbers: [] };
  }
  if (Date.now() - cached.updatedAt > CONTEXT_CACHE_TTL_MS) {
    conversationContextCache.delete(conversationId);
    return { docType: '', documentNumbers: [] };
  }
  return {
    docType: cached.docType || '',
    documentNumbers: Array.isArray(cached.documentNumbers) ? cached.documentNumbers : []
  };
}

function updateCachedConversationContext(conversationId, { docType, documentNumbers }) {
  if (!conversationId) return;
  if (!docType && (!documentNumbers || !documentNumbers.length)) return;
  const existing = conversationContextCache.get(conversationId) || {};
  conversationContextCache.set(conversationId, {
    docType: docType || existing.docType || '',
    documentNumbers: documentNumbers?.length ? documentNumbers : existing.documentNumbers || [],
    searchFilters: existing.searchFilters || null,
    updatedAt: Date.now()
  });
}

function getCachedSearchFilters(conversationId) {
  if (!conversationId) return { filters: null };
  const cached = conversationContextCache.get(conversationId);
  if (!cached) return { filters: null };
  if (Date.now() - cached.updatedAt > CONTEXT_CACHE_TTL_MS) {
    conversationContextCache.delete(conversationId);
    return { filters: null };
  }
  return {
    filters: cached.searchFilters || null
  };
}

function updateCachedSearchFilters(conversationId, filters) {
  if (!conversationId || !hasSearchFilters(filters || {})) return;
  const existing = conversationContextCache.get(conversationId) || {};
  conversationContextCache.set(conversationId, {
    docType: existing.docType || '',
    documentNumbers: existing.documentNumbers || [],
    searchFilters: { ...filters },
    updatedAt: Date.now()
  });
}

function normalizeSearchFilters(filters = {}, { userId, userQuery } = {}) {
  const docType = normalizeDocType(filters?.docType);
  const creator = normalizeUserFilter(filters?.creator, userId);
  const approver = normalizeUserFilter(filters?.approver, userId);
  const countRequested = normalizeCountFlag(filters?.count);
  const top = normalizeNumber(filters?.top);
  const skip = normalizeNumber(filters?.skip);
  const topN = normalizeNumber(filters?.topN);
  const minValue = normalizeNumber(filters?.minValue);
  const overdueDays = normalizeNumber(filters?.overdueDays);
  const poStatus = normalizeUpperValue(filters?.poStatus);
  const prStatus = normalizeUpperValue(filters?.prStatus);
  const seStatus = normalizeUpperValue(filters?.seStatus);
  const saStatus = normalizeUpperValue(filters?.saStatus);
  const reportType = normalizeUpperValue(filters?.reportType);
  const paymentStatus = isOverdueReportType(reportType)
    ? undefined
    : normalizePaymentStatus(filters?.paymentStatus, userQuery);

  const normalizedFilters = {
    ...filters,
    docType,
    creator,
    approver,
    paymentStatus,
    poStatus,
    prStatus,
    seStatus,
    saStatus,
    reportType,
    topN,
    minValue,
    overdueDays,
    top,
    skip,
    count: countRequested
  };

  return {
    filters: normalizedFilters,
    countRequested,
    paymentStatus,
    hasFilters: hasSearchFilters(normalizedFilters)
  };
}

function extractDocumentContextFromText(text) {
  if (!text) return { docType: '', documentNumbers: [] };
  const content = `${text}`;
  const candidates = [];
  let fallbackDocType = '';

  const headingPatterns = [
    { docType: 'PO', regex: /Purchase Order Status\s*\(PO:\s*([^)]+)\)/i },
    { docType: 'PR', regex: /Purchase Requisition Status\s*\(PR:\s*([^)]+)\)/i },
    { docType: 'INV', regex: /Invoice Status\s*\(Invoice:\s*([^)]+)\)/i }
  ];

  headingPatterns.forEach(({ docType, regex }) => {
    const match = content.match(regex);
    if (match) {
      const numbers = normalizeDocNumbers(match[1]);
      if (numbers.length) {
        candidates.push({ docType, documentNumbers: numbers, index: match.index || 0 });
      } else if (!fallbackDocType) {
        fallbackDocType = docType;
      }
    }
  });

  const statusResultsMatch = content.match(/Status Results\s*\((PO|PR|INV)\)/i);
  if (statusResultsMatch) {
    const docType = statusResultsMatch[1];
    const requestedMatch = content.match(/Requested:\s*([^\n]+)/i);
    const numbers = normalizeDocNumbers(requestedMatch ? requestedMatch[1] : '');
    if (numbers.length) {
      candidates.push({
        docType,
        documentNumbers: numbers,
        index: statusResultsMatch.index || 0
      });
    } else if (!fallbackDocType) {
      fallbackDocType = docType;
    }
  }

  const labeledPatterns = [
    { docType: 'PO', regex: /(?:PO Number|Purchase Order)\s*(?:Number)?\s*[:#-]?\s*(\d{4,})/gi },
    { docType: 'PR', regex: /(?:PR Number|Purchase Requisition)\s*(?:Number)?\s*[:#-]?\s*(\d{4,})/gi },
    { docType: 'INV', regex: /(?:Invoice Number|Invoice No\.?|Invoice)\s*(?:Number)?\s*[:#-]?\s*([A-Z0-9-]{4,})/gi }
  ];

  labeledPatterns.forEach(({ docType, regex }) => {
    let match;
    while ((match = regex.exec(content)) !== null) {
      const numbers = normalizeDocNumbers(match[1]);
      if (numbers.length) {
        candidates.push({ docType, documentNumbers: numbers, index: match.index || 0 });
      } else if (!fallbackDocType) {
        fallbackDocType = docType;
      }
    }
  });

  if (!fallbackDocType) {
    const docTypeHints = [
      { docType: 'PO', regex: /\b(po|purchase order)\b/i },
      { docType: 'PR', regex: /\b(pr|purchase requisition)\b/i },
      { docType: 'INV', regex: /\b(inv|invoice)\b/i }
    ];

    for (const { docType, regex } of docTypeHints) {
      if (regex.test(content)) {
        fallbackDocType = docType;
        break;
      }
    }
  }

  const rawNumberMatches = Array.from(content.matchAll(/\b\d{6,}\b/g));
  if (rawNumberMatches.length) {
    const lastMatch = rawNumberMatches[rawNumberMatches.length - 1];
    const numbers = normalizeDocNumbers(lastMatch[0]);
    if (numbers.length) {
      candidates.push({
        docType: fallbackDocType,
        documentNumbers: numbers,
        index: lastMatch.index || 0
      });
    }
  }

  if (candidates.length) {
    candidates.sort((a, b) => b.index - a.index);
    return candidates[0];
  }

  return { docType: fallbackDocType, documentNumbers: [] };
}

async function resolveDocumentContextFromHistory(aiEngine, req, conversationId) {
  if (!conversationId) return { docType: '', documentNumbers: [] };
  try {
    const historyResponse = await aiEngine.tx(req).send({
      method: 'POST',
      path: '/getConversationHistory',
      data: { conversationId }
    });

    const parsed =
      typeof historyResponse === 'string'
        ? JSON.parse(historyResponse)
        : historyResponse;

    const messages =
      (Array.isArray(parsed) && parsed) ||
      parsed?.history ||
      parsed?.messages ||
      parsed?.conversation ||
      [];

    let fallbackDocType = '';

    for (let idx = messages.length - 1; idx >= 0; idx -= 1) {
      const content =
        messages[idx]?.content ||
        messages[idx]?.text ||
        messages[idx]?.message ||
        '';
      if (!content) continue;

      const context = extractDocumentContextFromText(content);
      if (context.documentNumbers.length) {
        return context;
      }
      if (!fallbackDocType && context.docType) {
        fallbackDocType = context.docType;
      }
    }

    return { docType: fallbackDocType, documentNumbers: [] };
  } catch (error) {
    console.warn('Unable to resolve document context from conversation history.');
  }
  return { docType: '', documentNumbers: [] };
}

function formatDocumentStatusNice(docType, numbers, resp) {
  const poItems = Array.isArray(resp?.poItems) ? resp.poItems : [];
  const prItems = Array.isArray(resp?.prItems) ? resp.prItems : [];
  const invoiceItems = Array.isArray(resp?.invoiceItems) ? resp.invoiceItems : [];
  const lines = [];
  const listLabel = numbers.length ? numbers.join(', ') : 'N/A';

  lines.push(`Status Results (${docType})`);
  lines.push(joinLine('Requested', listLabel));
  if (resp?.totalCount !== null && resp?.totalCount !== undefined) {
    lines.push(joinLine('Total Count', resp.totalCount));
  }
  lines.push('');

  if (docType === 'PO') {
    lines.push('Purchase Order Items:');
    if (!poItems.length) {
      lines.push('No PO items returned.');
    } else {
      poItems.forEach((it, idx) => {
        formatPoItemDetails(lines, it, idx);
      });
    }

    lines.push('Related Purchase Requisitions:');
    if (!prItems.length) {
      lines.push('No related PR items returned.');
    } else {
      prItems.forEach((it, idx) => {
        formatPrItemDetails(lines, it, idx);
      });
    }

    lines.push('Related Invoices:');
    if (!invoiceItems.length) {
      lines.push('No related invoice items returned.');
    } else {
      invoiceItems.forEach((it, idx) => {
        formatInvoiceItemDetails(lines, it, idx);
      });
    }

    return lines.join('\n');
  }

  if (docType === 'PR') {
    lines.push('Purchase Requisition Items:');
    if (!prItems.length) {
      lines.push('No PR items returned.');
    } else {
      prItems.forEach((it, idx) => {
        formatPrItemDetails(lines, it, idx);
      });
    }

    lines.push('Related Purchase Orders:');
    if (!poItems.length) {
      lines.push('No related PO items returned.');
    } else {
      poItems.forEach((it, idx) => {
        formatPoItemDetails(lines, it, idx);
      });
    }

    lines.push('Related Invoices:');
    if (!invoiceItems.length) {
      lines.push('No related invoice items returned.');
    } else {
      invoiceItems.forEach((it, idx) => {
        formatInvoiceItemDetails(lines, it, idx);
      });
    }

    return lines.join('\n');
  }

  lines.push('Invoice Items:');
  if (!invoiceItems.length) {
    lines.push('No invoice items returned.');
  } else {
    invoiceItems.forEach((it, idx) => {
      formatInvoiceItemDetails(lines, it, idx);
    });
  }

  if (poItems.length) {
    lines.push('Related Purchase Orders:');
    poItems.forEach((it, idx) => {
      formatPoItemDetails(lines, it, idx);
    });
  }

  if (prItems.length) {
    lines.push('Related Purchase Requisitions:');
    prItems.forEach((it, idx) => {
      formatPrItemDetails(lines, it, idx);
    });
  }

  return lines.join('\n');
}

const CLOSING_LINE = 'Let me know if you need anything else.';

function ensureClosingLine(content) {
  const trimmed = (content ?? '').trim();
  if (!trimmed) return CLOSING_LINE;
  const normalizedClosing = CLOSING_LINE.replace(/[.!?]+$/, '').toLowerCase();
  const normalizedContent = trimmed.replace(/[.!?]+$/, '').toLowerCase();
  if (normalizedContent.endsWith(normalizedClosing)) {
    return trimmed;
  }
  return `${trimmed}\n\n${CLOSING_LINE}`;
}

function formatDocTypeLabel(docType) {
  switch (docType) {
    case 'PO':
      return 'purchase order';
    case 'PR':
      return 'purchase requisition';
    case 'INV':
      return 'invoice';
    default:
      return 'document';
  }
}

function formatDateRange(dateFrom, dateTo) {
  if (dateFrom && dateTo) {
    return `from ${dateFrom} to ${dateTo}`;
  }
  if (dateFrom) {
    return `from ${dateFrom}`;
  }
  if (dateTo) {
    return `through ${dateTo}`;
  }
  return '';
}

function prependQuestionContext(userQuery, content) {
  const normalizedQuestion = typeof userQuery === 'string' ? userQuery.trim() : '';
  const normalizedContent = typeof content === 'string' ? content.trim() : '';

  if (!normalizedContent || !normalizedQuestion) {
    return normalizedContent || content;
  }

  if (normalizedContent.startsWith('Here are the results for your question:')) {
    return normalizedContent;
  }

  return `Here are the results for your question: "${normalizedQuestion}"\n${normalizedContent}`;
}

function shouldPrependQuestionContext({ category, isDeterministic }) {
  if (!isDeterministic) return false;
  if (category === 'generic-query') return false;
  if (category === 'document-search') return false;
  return true;
}

function formatSearchCountSummary(totalCount, { docType, paymentStatus, dateFrom, dateTo } = {}) {
  const label = formatDocTypeLabel(docType);
  const pluralLabel = totalCount === 1 ? label : `${label}s`;
  const paymentSuffix =
    paymentStatus === 'Not yet Paid'
      ? ' with payment due'
      : paymentStatus === 'PAID'
      ? ' that are paid'
      : paymentStatus === 'PARTIAL'
      ? ' with partial payment'
      : '';
  const dateRange = formatDateRange(dateFrom, dateTo);
  const dateSuffix = dateRange ? ` ${dateRange}` : '';
  return `There ${totalCount === 1 ? 'is' : 'are'} ${totalCount} ${pluralLabel}${paymentSuffix}${dateSuffix}.`;
}

function buildListRetrievalSummary({ totalCount, shownCount, pageSize, skip, label } = {}) {
  if (!Number.isFinite(totalCount)) return '';
  const safeTotalCount = Math.max(totalCount, 0);
  const safePageSize = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : PAGE_SIZE_DEFAULT;
  const safeSkip = Number.isFinite(skip) && skip > 0 ? skip : 0;
  const safeShownCount = Number.isFinite(shownCount) && shownCount >= 0 ? shownCount : Math.min(safePageSize, safeTotalCount);
  const safeLabel = label || 'records';

  if (safeTotalCount === 0) {
    return `Total 0 ${safeLabel} found for your search criteria.`;
  }

  const start = Math.max(safeSkip + 1, 1);
  const calculatedEnd = safeShownCount > 0 ? start + safeShownCount - 1 : safeSkip + safePageSize;
  const end = Math.min(calculatedEnd, safeTotalCount);
  const displayedCount = Math.max(end - start + 1, 0);
  const base = `Total ${safeTotalCount} ${safeLabel} found for your search criteria, displaying top ${displayedCount} records i.e. ${start}-${end} records.`;
  const remaining = safeTotalCount - end;
  if (remaining <= 0) {
    return `${base} Let me know if you want to refine your search further.`;
  }
  return `${base} Let me know if you want to see next ${safePageSize} records or can refine your search further.`;
}

function formatSearchResultsNice(
  resp,
  { countRequested, filters = {}, docType, paymentStatus, dateFrom, dateTo, pageSize, skip } = {}
) {
  const poItems = Array.isArray(resp?.poItems) ? resp.poItems : [];
  const prItems = Array.isArray(resp?.prItems) ? resp.prItems : [];
  const invoiceItems = Array.isArray(resp?.invoiceItems) ? resp.invoiceItems : [];
  const lines = [];

  const resolvedDocType = docType || filters?.docType;
  const resolvedPaymentStatus = paymentStatus || filters?.paymentStatus;
  const resolvedDateFrom = dateFrom || filters?.dateFrom;
  const resolvedDateTo = dateTo || filters?.dateTo;
  const hasLineItems = poItems.length || prItems.length || invoiceItems.length;
  const overdueResponse = formatOverdueReportPayload(resp, filters);

  if (overdueResponse) {
    return overdueResponse;
  }

  if (countRequested && !hasLineItems && resp?.totalCount !== null && resp?.totalCount !== undefined) {
    return formatSearchCountSummary(resp.totalCount, {
      docType: resolvedDocType,
      paymentStatus: resolvedPaymentStatus,
      dateFrom: resolvedDateFrom,
      dateTo: resolvedDateTo
    });
  }

  const resolvedPageSize = pageSize || PAGE_SIZE_DEFAULT;
  const shownCount = poItems.length + prItems.length + invoiceItems.length;
  const listSummary = buildListRetrievalSummary({
    totalCount: Number.isFinite(resp?.totalCount) ? resp.totalCount : shownCount,
    shownCount,
    pageSize: resolvedPageSize,
    skip: skip || 0,
    label: resolvedDocType === 'INV' ? 'invoices' : resolvedDocType === 'PO' ? 'purchase orders' : resolvedDocType === 'PR' ? 'purchase requisitions' : 'records'
  });

  if (listSummary) {
    lines.push(listSummary);
    lines.push('');
  }

  if (poItems.length) {
    lines.push('Purchase Order Items:');
    poItems.forEach((it, idx) => {
      formatPoItemDetails(lines, it, idx);
    });
  }

  if (prItems.length) {
    lines.push('Purchase Requisition Items:');
    prItems.forEach((it, idx) => {
      formatPrItemDetails(lines, it, idx);
    });
  }

  if (invoiceItems.length) {
    lines.push('Invoice Items:');
    invoiceItems.forEach((it, idx) => {
      formatInvoiceItemDetails(lines, it, idx);
    });
  }

  if (!poItems.length && !prItems.length && !invoiceItems.length) {
    if (countRequested && resp?.totalCount !== null && resp?.totalCount !== undefined) {
      lines.push('No line items returned for the count-only request.');
    } else {
      lines.push('No matching documents were returned for the selected filters.');
    }
  }

  return lines.join('\n');
}

// ---------------- CATEGORY HANDLERS ----------------
const categoryHandlers = {
  'status-clarification': async ({ determinationJson }) => {
    const referenceNumber = determinationJson?.referenceNumber
      ? `${determinationJson.referenceNumber}`.trim()
      : '';

    const askForType =
      'Are you looking for the status of a purchase order, invoice, or purchase requisition?';

    const content = referenceNumber
      ? `${askForType} Please confirm what document type the number ${referenceNumber} refers to.`
      : `${askForType} Please share the relevant document number as well.`;

    return {
      deterministic: {
        role: 'assistant',
        content,
        additionalContents: []
      }
    };
  },

  'document-status': async ({ determinationJson }) => {
    const docType = normalizeDocType(determinationJson?.docType);
    const documentNumbers = normalizeDocNumbers(
      determinationJson?.documentNumbers ||
        determinationJson?.purchaseOrder ||
        determinationJson?.purchaseRequisition ||
        determinationJson?.invoice
    );

    if (!docType && documentNumbers.length) {
      return {
        deterministic: {
          role: 'assistant',
          content:
            'Are you looking for the status of a purchase order, invoice, or purchase requisition? Please confirm the document type.',
          additionalContents: []
        }
      };
    }

    if (!docType) {
      return {
        deterministic: {
          role: 'assistant',
          content: 'Please specify whether you need the status of a purchase order, purchase requisition, or invoice.',
          additionalContents: []
        }
      };
    }

    if (!documentNumbers.length) {
      return {
        deterministic: {
          role: 'assistant',
          content: `Please provide the ${docType} document number(s) so I can check the status.`,
          additionalContents: []
        }
      };
    }

    if (documentNumbers.length > 5) {
      return {
        deterministic: {
          role: 'assistant',
          content:
            'Please provide up to 5 document numbers at a time. I can only check the status for a maximum of five documents per request.',
          additionalContents: []
        }
      };
    }

    const serviceResponse = await marine_util.getDocumentStatus({
      docType,
      numbers: documentNumbers
    });

    const hasData =
      serviceResponse?.success &&
      ((Array.isArray(serviceResponse.poItems) && serviceResponse.poItems.length > 0) ||
        (Array.isArray(serviceResponse.prItems) && serviceResponse.prItems.length > 0) ||
        (Array.isArray(serviceResponse.invoiceItems) && serviceResponse.invoiceItems.length > 0));

    if (!hasData) {
      return {
        deterministic: {
          role: 'assistant',
          content:
            'No results found for the provided search criteria. Please check and provide valid data.',
          additionalContents: []
        }
      };
    }

    const content = formatDocumentStatusNice(docType, documentNumbers, serviceResponse);

    return {
      deterministic: {
        role: 'assistant',
        content,
        includeClosingLine: true,
        additionalContents: []
      }
    };
  },

  'document-search': async ({ determinationJson, user_query, userId, conversationId }) => {
    const rawFilters = extractSearchFilters(determinationJson);
    const {
      filters,
      countRequested,
      paymentStatus,
      hasFilters
    } = normalizeSearchFilters(rawFilters, { userId, userQuery: user_query });
    const docType = normalizeDocType(filters?.docType);
    const creator = filters?.creator;
    const approver = filters?.approver;
    const requestedTop = normalizeNumber(filters?.top);
    const requestedSkip = normalizeNumber(filters?.skip);
    const paginationRequest = parsePaginationRequest(user_query);
    const pageSize = paginationRequest?.pageSize || PAGE_SIZE_DEFAULT;
    const top = countRequested
      ? undefined
      : paginationRequest?.isNextPage
        ? pageSize
        : requestedTop && requestedTop > 0
          ? Math.min(requestedTop, PAGE_SIZE_DEFAULT)
          : pageSize;
    const skip = countRequested
      ? undefined
      : paginationRequest?.isNextPage
        ? (requestedSkip || 0) + pageSize
        : 0;

    if (!hasFilters && !user_query) {
      return {
        deterministic: {
          role: 'assistant',
          content: 'Please share the search criteria (for example date range, document type, or creator).',
          additionalContents: []
        }
      };
    }

    const countResponse =
      countRequested
        ? null
        : await marine_util.searchDocuments({
            purchaseOrder: filters?.purchaseOrder,
            purchaseRequisition: filters?.purchaseRequisition,
            invoice: filters?.invoice,
            vendor: filters?.vendor,
            dateFrom: filters?.dateFrom,
            dateTo: filters?.dateTo,
            approveFromDate: filters?.approveFromDate,
            approveToDate: filters?.approveToDate,
            dueFromDate: filters?.dueFromDate,
            dueToDate: filters?.dueToDate,
            docType,
            creator,
            approver,
            paymentStatus,
            costCenter: filters?.costCenter,
            wbs: filters?.wbs,
            glAccount: filters?.glAccount,
            poStatus: filters?.poStatus,
            prStatus: filters?.prStatus,
            seStatus: filters?.seStatus,
            reportType: filters?.reportType,
            purchasingOrg: filters?.purchasingOrg,
            topN: filters?.topN,
            minValue: filters?.minValue,
            description: filters?.description,
            overdueDays: filters?.overdueDays,
            count: true
          });

    const serviceResponse = await marine_util.searchDocuments({
      purchaseOrder: filters?.purchaseOrder,
      purchaseRequisition: filters?.purchaseRequisition,
      invoice: filters?.invoice,
      vendor: filters?.vendor,
      dateFrom: filters?.dateFrom,
      dateTo: filters?.dateTo,
      approveFromDate: filters?.approveFromDate,
      approveToDate: filters?.approveToDate,
      dueFromDate: filters?.dueFromDate,
      dueToDate: filters?.dueToDate,
      docType,
      creator,
      approver,
      paymentStatus,
      costCenter: filters?.costCenter,
      wbs: filters?.wbs,
      glAccount: filters?.glAccount,
      poStatus: filters?.poStatus,
      prStatus: filters?.prStatus,
      seStatus: filters?.seStatus,
      reportType: filters?.reportType,
      purchasingOrg: filters?.purchasingOrg,
      topN: filters?.topN,
      minValue: filters?.minValue,
      description: filters?.description,
      overdueDays: filters?.overdueDays,
      top,
      skip,
      count: countRequested
    });

    if (!countRequested && countResponse?.totalCount !== null && countResponse?.totalCount !== undefined) {
      serviceResponse.totalCount = countResponse.totalCount;
    }

    updateCachedSearchFilters(conversationId, {
      ...filters,
      top,
      skip,
      count: false
    });

    const hasData =
      serviceResponse?.success &&
      ((Array.isArray(serviceResponse.poItems) && serviceResponse.poItems.length > 0) ||
        (Array.isArray(serviceResponse.prItems) && serviceResponse.prItems.length > 0) ||
        (Array.isArray(serviceResponse.invoiceItems) && serviceResponse.invoiceItems.length > 0) ||
        (countRequested && serviceResponse?.totalCount !== null));

    if (!hasData) {
      return {
        deterministic: {
          role: 'assistant',
          content: 'I could not find documents for the provided search criteria.',
          additionalContents: []
        }
      };
    }

    const content = formatSearchResultsNice(serviceResponse, {
      countRequested,
      docType,
      paymentStatus,
      dateFrom: filters?.dateFrom,
      dateTo: filters?.dateTo,
      pageSize: top || PAGE_SIZE_DEFAULT,
      skip: skip || 0
    });

    return {
      deterministic: {
        role: 'assistant',
        content,
        includeClosingLine: true,
        additionalContents: []
      }
    };
  },

  'purchase-order-status': async ({ determinationJson }) => {
    const purchaseOrder = determinationJson?.purchaseOrder
      ? `${determinationJson.purchaseOrder}`.trim()
      : '';

    if (!purchaseOrder) {
      return {
        deterministic: {
          role: 'assistant',
          content: 'Please provide a purchase order number so I can check its status.',
          additionalContents: []
        }
      };
    }

    const serviceResponse = await marine_util.getDocumentStatus({
      docType: 'PO',
      numbers: [purchaseOrder]
    });

    const hasData =
      serviceResponse?.success &&
      ((Array.isArray(serviceResponse.poItems) && serviceResponse.poItems.length > 0) ||
        (Array.isArray(serviceResponse.prItems) && serviceResponse.prItems.length > 0));

    if (!hasData) {
      return {
        deterministic: {
          role: 'assistant',
          content:
            'No results found for the provided search criteria. Please check and provide valid data.',
          additionalContents: []
        }
      };
    }

    const content = formatPoStatusNice(purchaseOrder, serviceResponse);

    return {
      deterministic: {
        role: 'assistant',
        content,
        includeClosingLine: true,
        additionalContents: []
      }
    };
  },

  'invoice-status': async ({ determinationJson }) => {
    const purchaseOrder = determinationJson?.purchaseOrder
      ? `${determinationJson.purchaseOrder}`.trim()
      : '';

    if (!purchaseOrder) {
      return {
        deterministic: {
          role: 'assistant',
          content: 'Please provide an invoice number so I can check its status.',
          additionalContents: []
        }
      };
    }

    const serviceResponse = await marine_util.getDocumentStatus({
      docType: 'INV',
      numbers: [purchaseOrder]
    });

    const hasData =
      serviceResponse?.success &&
      Array.isArray(serviceResponse.invoiceItems) &&
      serviceResponse.invoiceItems.length > 0;

    if (!hasData) {
      return {
        deterministic: {
          role: 'assistant',
          content:
            'No results found for the provided search criteria. Please check and provide valid data.',
          additionalContents: []
        }
      };
    }

    const content = formatInvoiceStatusNice(purchaseOrder, serviceResponse);

    return {
      deterministic: {
        role: 'assistant',
        content,
        includeClosingLine: true,
        additionalContents: []
      }
    };
  },

  'purchase-requisition-status': async ({ determinationJson }) => {
    const purchaseRequisition = determinationJson?.purchaseRequisition
      ? `${determinationJson.purchaseRequisition}`.trim()
      : '';

    if (!purchaseRequisition) {
      return {
        deterministic: {
          role: 'assistant',
          content: 'Please provide a purchase requisition number so I can check its status.',
          additionalContents: []
        }
      };
    }

    const serviceResponse = await marine_util.getDocumentStatus({
      docType: 'PR',
      numbers: [purchaseRequisition]
    });

    const hasData =
      serviceResponse?.success &&
      ((Array.isArray(serviceResponse.prItems) && serviceResponse.prItems.length > 0) ||
        (Array.isArray(serviceResponse.poItems) && serviceResponse.poItems.length > 0));

    if (!hasData) {
      return {
        deterministic: {
          role: 'assistant',
          content:
            'No results found for the provided search criteria. Please check and provide valid data.',
          additionalContents: []
        }
      };
    }

    const content = formatPrStatusNice(purchaseRequisition, serviceResponse);

    return {
      deterministic: {
        role: 'assistant',
        content,
        includeClosingLine: true,
        additionalContents: []
      }
    };
  }
};

// ---------------------- CAP SERVICE ----------------------
module.exports = function () {
  /**
   * Main chat action called from UI
   */
  this.on('getChatRagResponse', async (req) => {
    const startTime = Date.now();

    try {
      const {
        conversationId,
        messageId,
        message_time,
        user_id,
        user_query,
        appId
      } = req.data;
      const userMessageTime = message_time || new Date().toISOString();

      const memoryEntities = cds.entities('marine.chatbot') || {};
      const { Conversation, Message } = memoryEntities;
      const shouldPersistMemory = Boolean(conversationId && Conversation && Message);
      let memoryContext = [];

      if (shouldPersistMemory) {
        try {
          memoryContext = await handleMemoryBeforeRagCall(
            conversationId,
            messageId,
            userMessageTime,
            user_id,
            user_query,
            Conversation,
            Message
          );
        } catch (error) {
          console.warn('Unable to persist user message for memory context.', error);
          memoryContext = [];
        }
      }

      // 1) CLASSIFICATION – REMOTE via AI Engine destination
      const aiEngine = await cds.connect.to('AI_ENGINE');

      const classifyResult = await aiEngine.tx(req).send({
        method: 'POST',
        path: '/classifyUserQuery',
        data: {
          user_query,
          systemPrompt
        }
      });

      let category = classifyResult?.category;
      let determinationJson = JSON.parse(classifyResult?.determinationJson || '{}');

      console.log('AI ENGINE Classification', {
        query: user_query,
        classification: determinationJson
      });

      let docType = normalizeDocType(determinationJson?.docType);
      let documentNumbers = normalizeDocNumbers(
        determinationJson?.documentNumbers ||
          determinationJson?.purchaseOrder ||
          determinationJson?.purchaseRequisition ||
          determinationJson?.invoice ||
          determinationJson?.referenceNumber
      );

      const incomingFilters = extractSearchFilters(determinationJson);
      const hasIncomingFilters = hasSearchFilters(incomingFilters);
      const cachedSearch = getCachedSearchFilters(conversationId);
      const shouldReuseSearchFilters = !hasIncomingFilters && cachedSearch.filters &&
        (isListFollowUp(user_query) || hasFollowUpHint(user_query));

      if (!category) {
        if (hasIncomingFilters) {
          category = 'document-search';
        } else if (docType || documentNumbers.length) {
          category = 'document-status';
        } else {
          category = 'generic-query';
        }
      }

      if (shouldReuseSearchFilters) {
        determinationJson = {
          ...determinationJson,
          filters: {
            ...cachedSearch.filters,
            count: false
          }
        };
        category = 'document-search';
      } else if (hasIncomingFilters) {
        determinationJson = {
          ...determinationJson,
          filters: incomingFilters
        };
      }

      if (!docType || documentNumbers.length === 0) {
        const queryContext = extractDocumentContextFromText(user_query);
        if (!docType && queryContext.docType) {
          docType = queryContext.docType;
        }
        if (!documentNumbers.length && queryContext.documentNumbers.length) {
          documentNumbers = queryContext.documentNumbers;
        }
      }

      const cachedContext = getCachedConversationContext(conversationId);
      if (!docType && cachedContext.docType) {
        docType = cachedContext.docType;
      }
      if (!documentNumbers.length && cachedContext.documentNumbers.length) {
        documentNumbers = cachedContext.documentNumbers;
      }

      const shouldResolveFromHistory =
        hasFollowUpHint(user_query) ||
        (docType && documentNumbers.length === 0) ||
        ((category === 'document-status' || category === 'status-clarification') &&
          (!docType || documentNumbers.length === 0));

      if (shouldResolveFromHistory && (!docType || documentNumbers.length === 0)) {
        const historyContext = await resolveDocumentContextFromHistory(aiEngine, req, conversationId);
        if (!docType && historyContext.docType) {
          docType = historyContext.docType;
        }
        if (!documentNumbers.length && historyContext.documentNumbers.length) {
          documentNumbers = historyContext.documentNumbers;
        }
      }

      if ((docType || documentNumbers.length) && category !== 'document-search') {
        if (category === 'status-clarification') {
          category = 'document-status';
        } else if (category === 'document-status') {
          category = 'document-status';
        } else if (docType && (documentNumbers.length || shouldResolveFromHistory)) {
          category = 'document-status';
        }
      }

      if (docType || documentNumbers.length) {
        determinationJson = {
          ...determinationJson,
          docType: docType || determinationJson?.docType,
          documentNumbers: documentNumbers.length ? documentNumbers : determinationJson?.documentNumbers
        };
      }

      updateCachedConversationContext(conversationId, { docType, documentNumbers });

      if (!basePrompts[category]) {
        throw new Error(`${category} is not in the supported categories`);
      }

      // 2) Run project-specific category handler
      const promptResponses = { ...basePrompts };
      let deterministicResponse = null;

      if (categoryHandlers[category]) {
        const { prompt, deterministic } =
          (await categoryHandlers[category]({
            determinationJson,
            user_query,
            userId: user_id,
            conversationId,
            basePrompt: promptResponses[category]
          })) || {};

        if (prompt) promptResponses[category] = prompt;
        if (deterministic) deterministicResponse = deterministic;
      }

      // 3) If deterministic → no RAG call
      if (deterministicResponse) {
        const deterministicContent = shouldPrependQuestionContext({ category, isDeterministic: true })
          ? prependQuestionContext(user_query, deterministicResponse.content)
          : deterministicResponse.content;
        const responseTimestamp = new Date().toISOString();

        await logUsageToAiEngine(req, {
          category,
          startTime,
          isDeterministic: true,
          conversationId,
          messageId,
          userId: user_id
        });

        if (shouldPersistMemory) {
          try {
            await handleMemoryAfterRagCall(
              conversationId,
              responseTimestamp,
              { ...deterministicResponse, content: deterministicContent },
              Message,
              Conversation
            );
          } catch (error) {
            console.warn('Unable to persist deterministic response for memory.', error);
          }
        }

        return {
          role: deterministicResponse.role,
          content: deterministicContent,
          messageTime: responseTimestamp,
          messageId: messageId || null,
          additionalContents: JSON.stringify(deterministicResponse.additionalContents || [])
        };
      }

      // 4) RAG via AI ENGINE (remote CAP app via destination)
      const ragResult = await aiEngine.tx(req).send({
        method: 'POST',
        path: '/ragWithSdk',
        data: {
          conversationId,
          messageId,
          message_time: userMessageTime,
          user_id,
          userQuery: user_query,
          appId: 'MARINE-CHATBOT',
          tableName,
          embeddingColumn,
          contentColumn,
          prompt: promptResponses[category],
          context: memoryContext,
          topK: 30
        }
      });

      // Normalize completion & additionalContents
      let completionObj;
      if (typeof ragResult?.completion === 'string') {
        try {
          completionObj = JSON.parse(ragResult.completion);
        } catch (e) {
          console.warn('RAG completion is not valid JSON string, using fallback.', ragResult.completion);
          completionObj = { role: 'assistant', content: ragResult?.completion || '' };
        }
      } else if (ragResult?.completion) {
        completionObj = ragResult.completion;
      } else {
        completionObj = {
          role: 'assistant',
          content: ragResult?.content || 'I was unable to generate a response at this time. Please try again.'
        };
      }

      let additionalContentsArr;
      if (typeof ragResult?.additionalContents === 'string') {
        try {
          additionalContentsArr = JSON.parse(ragResult.additionalContents);
        } catch (e) {
          console.warn('RAG additionalContents is not valid JSON string, defaulting to [].', ragResult.additionalContents);
          additionalContentsArr = [];
        }
      } else {
        additionalContentsArr = ragResult?.additionalContents || [];
      }

      const responseTimestamp = new Date().toISOString();
      const completionContent = shouldPrependQuestionContext({ category, isDeterministic: false })
        ? prependQuestionContext(user_query, completionObj?.content)
        : completionObj?.content;

      await logUsageToAiEngine(req, {
        category,
        startTime,
        isDeterministic: false,
        conversationId,
        messageId,
        userId: user_id
      });

      if (shouldPersistMemory) {
        try {
            await handleMemoryAfterRagCall(
              conversationId,
              responseTimestamp,
              { ...completionObj, content: completionContent },
              Message,
              Conversation
            );
        } catch (error) {
          console.warn('Unable to persist assistant response for memory.', error);
        }
      }

      return {
        role: completionObj.role,
        content: completionContent,
        messageTime: responseTimestamp,
        messageId: messageId || null,
        additionalContents: JSON.stringify(additionalContentsArr)
      };
    } catch (error) {
      console.error('Error while generating response for user query:', error);
      throw error;
    }
  });

  async function logUsageToAiEngine(req, { category, startTime, isDeterministic, conversationId, messageId, userId }) {
    try {
      const aiEngine = await cds.connect.to('AI_ENGINE');
      const durationMs = Date.now() - startTime;

      await aiEngine.tx(req).send({
        method: 'POST',
        path: '/logUsage',
        data: {
          sourceService: 'MARINE',
          category,
          isDeterministic,
          durationMs,
          conversationId,
          messageId,
          userId,
          tenantId: req.tenant || ''
        }
      });
    } catch (e) {
      console.warn('Failed to log usage to AI engine', e);
    }
  }

  this.on('getConversationHistoryFromEngine', async (req) => {
    try {
      const aiEngine = await cds.connect.to('AI_ENGINE');
      return aiEngine.tx(req).send({
        method: 'POST',
        path: '/getConversationHistory',
        data: { conversationId: req.data.conversationId }
      });
    } catch (error) {
      console.warn('Unable to fetch conversation history from AI engine.');
      throw error;
    }
  });

  // ---------------------------------------------------------------------------
  // deleteChatData – delegated to AI engine (central cleanup)
  // ---------------------------------------------------------------------------
  this.on('deleteChatData', async (req) => {
    try {
      const aiEngine = await cds.connect.to('AI_ENGINE');

      await aiEngine.tx(req).send({
        method: 'POST',
        path: '/deleteAllChatData'
      });

      return 'Success!';
    } catch (error) {
      console.log('Error while deleting the chat content in AI engine:', error);
      throw error;
    }
  });
};
