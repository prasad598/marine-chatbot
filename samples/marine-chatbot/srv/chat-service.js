'use strict';

const cds = require('@sap/cds');
const marine_util = require('./marine-util');

const PROJECT_NAME = 'MARINE_USECASE';

// ---- CONFIG ----
const tableName = 'SAP_TISCE_DEMO_DOCUMENTCHUNK';
const embeddingColumn = 'EMBEDDING';
const contentColumn = 'TEXT_CHUNK';

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
    "dateFrom": "01.01.2025",
    "dateTo": "31.03.2025",
    "docType": "PO | PR | INV",
    "creator": "<user id or 'me'>",
    "approver": "<user id or 'me'>",
    "paymentStatus": "<PAID | NOTPAID | PARTIAL | etc>",
    "costCenter": "<cost center>",
    "wbs": "<wbs>",
    "glAccount": "<gl account>",
    "top": 10,
    "skip": 0,
    "count": true
  }
}

For all other questions (including queries answered from the embedding/policy documents), return:
{
  "category": "generic-query"
}

If the user asks for a status update but does not clearly specify whether it concerns a purchase order, invoice, or purchase requisition, return:
{
  "category": "status-clarification",
  "referenceNumber": "<number provided by the user if any, digits only>"
}

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
  const invoiceNo = pickFirst(it, ['invoiceNo', 'Invoice No', 'invoiceDocNumber']);
  const fiscalYear = pickFirst(it, ['Fiscal Year', 'fiscalYear'], '');
  const invoiceRef = pickFirst(it, ['Invoice Reference', 'invoiceReference'], '');
  const vendorCode = pickFirst(it, ['Vendor Code', 'vendorCode'], '');
  const vendorName = pickFirst(it, ['Vendor Name', 'vendorName'], '');
  const value = pickFirst(it, ['invoiceValue', 'Invoice Value', 'grossAmount'], '');
  const taxAmount = pickFirst(it, ['Tax Amount', 'taxAmount'], '');
  const netAmount = pickFirst(it, ['Net Amount', 'netAmount'], '');
  const currency = pickFirst(it, ['Currency', 'currency'], '');
  const status = pickFirst(it, ['paymentStatus', 'Payment Status', 'livStatus', 'LIV Status'], '');
  const docDate = pickFirst(it, ['invoiceDocDate', 'Doc Date'], '');
  const postDate = pickFirst(it, ['invoicePostDate', 'Posting Date'], '');
  const paymentDueOn = pickFirst(it, ['paymentDueOn', 'Payment Due On', 'paymentDueDate'], '');
  const clearingDoc = pickFirst(it, ['Clearing Document', 'clearingDocument'], '');
  const clearingDate = pickFirst(it, ['clearingDate', 'Clearing Date'], '');
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

function normalizeDocNumbers(rawNumbers) {
  if (!rawNumbers) return [];
  if (Array.isArray(rawNumbers)) {
    return rawNumbers
      .flatMap((entry) => `${entry}`.match(/\d+/g) || [])
      .map((value) => value.trim())
      .filter(Boolean);
  }

  return `${rawNumbers}`.match(/\d+/g)?.map((value) => value.trim()).filter(Boolean) || [];
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

  return lines.join('\n');
}

function formatSearchResultsNice(resp) {
  const poItems = Array.isArray(resp?.poItems) ? resp.poItems : [];
  const prItems = Array.isArray(resp?.prItems) ? resp.prItems : [];
  const invoiceItems = Array.isArray(resp?.invoiceItems) ? resp.invoiceItems : [];
  const lines = [];

  lines.push('Document Search Results');
  if (resp?.totalCount !== null && resp?.totalCount !== undefined) {
    lines.push(joinLine('Total Count', resp.totalCount));
  }
  if (resp?.resultCount !== null && resp?.resultCount !== undefined) {
    lines.push(joinLine('Result Count', resp.resultCount));
  }
  lines.push('');

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
    lines.push('No matching documents were returned for the selected filters.');
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
      const reason = serviceResponse?.message ? ` Reason: ${serviceResponse.message}` : '';
      return {
        deterministic: {
          role: 'assistant',
          content: `I cannot find status for the provided document(s).${reason}`,
          additionalContents: []
        }
      };
    }

    const content = formatDocumentStatusNice(docType, documentNumbers, serviceResponse);

    return {
      deterministic: {
        role: 'assistant',
        content,
        additionalContents: []
      }
    };
  },

  'document-search': async ({ determinationJson, user_query, userId }) => {
    const filters = determinationJson?.filters || {};
    const docType = normalizeDocType(filters?.docType);
    const creator = filters?.creator === 'me' ? userId : filters?.creator;
    const approver = filters?.approver === 'me' ? userId : filters?.approver;

    const hasFilters = Object.values(filters || {}).some((value) => value);

    if (!hasFilters && !user_query) {
      return {
        deterministic: {
          role: 'assistant',
          content: 'Please share the search criteria (for example date range, document type, or creator).',
          additionalContents: []
        }
      };
    }

    const serviceResponse = await marine_util.searchDocuments({
      dateFrom: filters?.dateFrom,
      dateTo: filters?.dateTo,
      docType,
      creator,
      approver,
      paymentStatus: filters?.paymentStatus,
      costCenter: filters?.costCenter,
      wbs: filters?.wbs,
      glAccount: filters?.glAccount,
      top: filters?.top,
      skip: filters?.skip,
      count: filters?.count
    });

    const hasData =
      serviceResponse?.success &&
      ((Array.isArray(serviceResponse.poItems) && serviceResponse.poItems.length > 0) ||
        (Array.isArray(serviceResponse.prItems) && serviceResponse.prItems.length > 0) ||
        (Array.isArray(serviceResponse.invoiceItems) && serviceResponse.invoiceItems.length > 0));

    if (!hasData) {
      const reason = serviceResponse?.message ? ` Reason: ${serviceResponse.message}` : '';
      return {
        deterministic: {
          role: 'assistant',
          content: `I could not find documents for the provided search criteria.${reason}`,
          additionalContents: []
        }
      };
    }

    const content = formatSearchResultsNice(serviceResponse);

    return {
      deterministic: {
        role: 'assistant',
        content,
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
      const reason = serviceResponse?.message ? ` Reason: ${serviceResponse.message}` : '';
      return {
        deterministic: {
          role: 'assistant',
          content: `I cannot find status for the provided purchase order.${reason}`,
          additionalContents: []
        }
      };
    }

    const content = formatPoStatusNice(purchaseOrder, serviceResponse);

    return {
      deterministic: {
        role: 'assistant',
        content,
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
      const reason = serviceResponse?.message ? ` Reason: ${serviceResponse.message}` : '';
      return {
        deterministic: {
          role: 'assistant',
          content: `I cannot find status for the provided invoice or purchase order.${reason}`,
          additionalContents: []
        }
      };
    }

    const content = formatInvoiceStatusNice(purchaseOrder, serviceResponse);

    return {
      deterministic: {
        role: 'assistant',
        content,
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
      const reason = serviceResponse?.message ? ` Reason: ${serviceResponse.message}` : '';
      return {
        deterministic: {
          role: 'assistant',
          content: `I cannot find status for the provided purchase requisition.${reason}`,
          additionalContents: []
        }
      };
    }

    const content = formatPrStatusNice(purchaseRequisition, serviceResponse);

    return {
      deterministic: {
        role: 'assistant',
        content,
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

      const category = classifyResult?.category;
      const determinationJson = JSON.parse(classifyResult?.determinationJson || '{}');

      console.log('AI ENGINE Classification', {
        query: user_query,
        classification: determinationJson
      });

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
            basePrompt: promptResponses[category]
          })) || {};

        if (prompt) promptResponses[category] = prompt;
        if (deterministic) deterministicResponse = deterministic;
      }

      // 3) If deterministic → no RAG call
      if (deterministicResponse) {
        const responseTimestamp = new Date().toISOString();

        await logUsageToAiEngine(req, {
          category,
          startTime,
          isDeterministic: true,
          conversationId,
          messageId,
          userId: user_id
        });

        return {
          role: deterministicResponse.role,
          content: deterministicResponse.content,
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
          message_time,
          user_id,
          userQuery: user_query,
          appId: 'MARINE-CHATBOT',
          tableName,
          embeddingColumn,
          contentColumn,
          prompt: promptResponses[category],
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

      await logUsageToAiEngine(req, {
        category,
        startTime,
        isDeterministic: false,
        conversationId,
        messageId,
        userId: user_id
      });

      return {
        role: completionObj.role,
        content: completionObj.content,
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
    const aiEngine = await cds.connect.to('AI_ENGINE');
    return aiEngine.tx(req).send({
      method: 'POST',
      path: '/getConversationHistory',
      data: { conversationId: req.data.conversationId }
    });
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
