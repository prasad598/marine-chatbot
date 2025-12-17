'use strict';

const cds = require('@sap/cds');

const marine_util = require('./marine-util');

const PROJECT_NAME = 'MARINE_USECASE';

// ---- CONFIG ----
const tableName = 'SAP_TISCE_DEMO_DOCUMENTCHUNK';
const embeddingColumn = 'EMBEDDING';
const contentColumn = 'TEXT_CHUNK';

// ---------------- SYSTEM PROMPT (classifier) ----------------
const systemPrompt = `Classify the user question into one of the following categories: purchase-order-status, invoice-status, purchase-requisition-status, status-clarification, or generic-query.

Return a JSON object following the examples below.

If the user requests the status of a purchase order, return:
{
  "category": "purchase-order-status",
  "purchaseOrder": "<purchase order number from the user, digits only>"
}

If the user requests the status of an invoice (including payment or invoice progress), return:
{
  "category": "invoice-status",
  "purchaseOrder": "<purchase order number tied to the invoice, digits only>"
}

If the user requests the status of a purchase requisition, return:
{
  "category": "purchase-requisition-status",
  "purchaseRequisition": "<purchase requisition number from the user, digits only>"
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
1. Always provide the number if it is mentioned; otherwise return an empty string for that field.
2. Prefer the number explicitly associated with the document type mentioned by the user.
3. If the request is ambiguous between purchase order and invoice, choose invoice-status when the user mentions invoice terms.
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

const invoiceStatusPrompt = `You are a marine procurement assistant. Use the provided invoice status context, delimited by triple backticks, to summarize the invoice details for the given purchase order.
- Include the invoice number, value, key dates, and invoice status.
- If the service response is empty or unsuccessful, state that you cannot find status for the provided invoice or purchase order.
- Keep the answer neatly formatted with short headings and bullet points.`;

const basePrompts = {
  'purchase-order-status': purchaseOrderStatusPrompt,
  'invoice-status': invoiceStatusPrompt,
  'purchase-requisition-status': purchaseRequisitionStatusPrompt,
  'status-clarification': genericRequestPrompt,
  'generic-query': genericRequestPrompt
};

// ---------------- Formatting helpers ----------------
function formatPurchaseOrderStatus(purchaseOrder, response) {
  const poItems = Array.isArray(response?.poItems) ? response.poItems : [];
  const prItems = Array.isArray(response?.prItems) ? response.prItems : [];
  const lines = [`Purchase Order ${purchaseOrder} status:`];

  if (poItems.length) {
    lines.push('Purchase Order Items:');
    lines.push(
      ...poItems.map((item) => {
        const itemNumber = item?.ebelp || item?.['PO Item'] || '';
        const status = item?.poStatus || item?.['PO Status'] || 'Unknown';
        const deleted = item?.poDeleted ?? item?.['PO Deleted'];
        const deletedText = deleted !== undefined ? String(deleted) : 'Unknown';
        return `- Item ${itemNumber || 'N/A'}: Status ${status} (Deleted: ${deletedText})`;
      })
    );
  } else {
    lines.push('- No purchase order line items returned.');
  }

  if (prItems.length) {
    lines.push('Related Purchase Requisitions:');
    lines.push(
      ...prItems.map((item) => {
        const prNumber = item?.banfn || item?.['PR Number'] || 'N/A';
        const prItem = item?.bnfpo || item?.['PR Item'] || 'N/A';
        const status = item?.prStatus || item?.['PR Status'] || 'Unknown';
        const releaseStatus = item?.['Release Status'] || item?.frgkz || '';
        const deleted = item?.prDeleted ?? item?.['PR Deleted'];
        const deletedText = deleted !== undefined ? String(deleted) : 'Unknown';
        return `- PR ${prNumber} / Item ${prItem}: Status ${status} ${releaseStatus ? `(Release: ${releaseStatus})` : ''}(Deleted: ${deletedText})`;
      })
    );
  }

  return lines.join('\n');
}

function formatPurchaseRequisitionStatus(purchaseRequisition, response) {
  const poItems = Array.isArray(response?.poItems) ? response.poItems : [];
  const prItems = Array.isArray(response?.prItems) ? response.prItems : [];
  const lines = [`Purchase Requisition ${purchaseRequisition} status:`];

  if (prItems.length) {
    lines.push('Requisition Items:');
    lines.push(
      ...prItems.map((item) => {
        const prItem = item?.bnfpo || item?.['PR Item'] || 'N/A';
        const status = item?.prStatus || item?.['PR Status'] || 'Unknown';
        const releaseStatus = item?.['Release Status'] || item?.frgkz || '';
        const deleted = item?.prDeleted ?? item?.['PR Deleted'];
        const deletedText = deleted !== undefined ? String(deleted) : 'Unknown';
        const linkedPo = item?.ebeln || item?.['PO Number'] || '';
        return `- Item ${prItem}: Status ${status} ${releaseStatus ? `(Release: ${releaseStatus})` : ''}${linkedPo ? ` | Linked PO: ${linkedPo}` : ''} (Deleted: ${deletedText})`;
      })
    );
  } else {
    lines.push('- No purchase requisition items returned.');
  }

  if (poItems.length) {
    lines.push('Related Purchase Orders:');
    lines.push(
      ...poItems.map((item) => {
        const poNumber = item?.ebeln || item?.['PO Number'] || 'N/A';
        const poItem = item?.ebelp || item?.['PO Item'] || 'N/A';
        const status = item?.poStatus || item?.['PO Status'] || 'Unknown';
        return `- PO ${poNumber} / Item ${poItem}: Status ${status}`;
      })
    );
  }

  return lines.join('\n');
}

function formatInvoiceStatus(purchaseOrder, response) {
  const items = Array.isArray(response?.items) ? response.items : [];
  const lines = [`Invoice status for Purchase Order ${purchaseOrder}:`];

  if (items.length) {
    lines.push(
      ...items.map((item) => {
        const invoiceNo = item?.invoiceNo || 'N/A';
        const value = item?.invoiceValue || 'N/A';
        const status = item?.livStatus || 'Unknown';
        const docDate = item?.invoiceDocDate || 'N/A';
        const postDate = item?.invoicePostDate || 'N/A';
        const paymentDueOn = item?.paymentDueOn || '';
        return `- Invoice ${invoiceNo}: Value ${value}, Status ${status}, Doc Date ${docDate}, Posting Date ${postDate}${paymentDueOn ? `, Payment Due ${paymentDueOn}` : ''}`;
      })
    );
  } else {
    lines.push('- No invoice status returned.');
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

    const serviceResponse = await marine_util.getPurchaseOrderStatus(purchaseOrder);
    const hasData = serviceResponse?.success &&
      ((Array.isArray(serviceResponse.poItems) && serviceResponse.poItems.length > 0) ||
        (Array.isArray(serviceResponse.prItems) && serviceResponse.prItems.length > 0));

    if (!hasData) {
      return {
        deterministic: {
          role: 'assistant',
          content: 'I cannot find status for the provided purchase order.',
          additionalContents: []
        }
      };
    }

    return {
      deterministic: {
        role: 'assistant',
        content: formatPurchaseOrderStatus(purchaseOrder, serviceResponse),
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
          content: 'Please provide a purchase order number so I can check the related invoice status.',
          additionalContents: []
        }
      };
    }

    const serviceResponse = await marine_util.getInvoiceStatus(purchaseOrder);
    const hasData = serviceResponse?.success &&
      Array.isArray(serviceResponse.items) &&
      serviceResponse.items.length > 0;

    if (!hasData) {
      return {
        deterministic: {
          role: 'assistant',
          content: 'I cannot find status for the provided invoice or purchase order.',
          additionalContents: []
        }
      };
    }

    return {
      deterministic: {
        role: 'assistant',
        content: formatInvoiceStatus(purchaseOrder, serviceResponse),
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

    const serviceResponse = await marine_util.getPurchaseRequisitionStatus(
      purchaseRequisition
    );
    const hasData = serviceResponse?.success &&
      ((Array.isArray(serviceResponse.prItems) && serviceResponse.prItems.length > 0) ||
        (Array.isArray(serviceResponse.poItems) && serviceResponse.poItems.length > 0));

    if (!hasData) {
      return {
        deterministic: {
          role: 'assistant',
          content: 'I cannot find status for the provided purchase requisition.',
          additionalContents: []
        }
      };
    }

    return {
      deterministic: {
        role: 'assistant',
        content: formatPurchaseRequisitionStatus(purchaseRequisition, serviceResponse),
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
      const determinationJson = JSON.parse(
        classifyResult?.determinationJson || '{}'
      );

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
            basePrompt: promptResponses[category]
          })) || {};

        if (prompt) {
          promptResponses[category] = prompt;
        }
        if (deterministic) {
          deterministicResponse = deterministic;
        }
      }

      // 3) If deterministic → no RAG call
      if (deterministicResponse) {
        const responseTimestamp = new Date().toISOString();

        // Log usage in AI engine
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
          additionalContents: JSON.stringify(
            deterministicResponse.additionalContents || []
          )
        };
      }

      // 4) RAG via AI ENGINE (remote CAP app via destination)
      const ragResult = await aiEngine.tx(req).send({
        method: 'POST',
        path: '/ragWithSdk', // exposed by AI engine CAP project
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
          // category-specific prompt
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
          console.warn(
            'RAG completion is not valid JSON string, using fallback.',
            ragResult.completion
          );
          completionObj = {
            role: 'assistant',
            content: ragResult?.completion || ''
          };
        }
      } else if (ragResult?.completion) {
        completionObj = ragResult.completion;
      } else {
        completionObj = {
          role: 'assistant',
          content:
            ragResult?.content ||
            'I was unable to generate a response at this time. Please try again.'
        };
      }

      let additionalContentsArr;
      if (typeof ragResult?.additionalContents === 'string') {
        try {
          additionalContentsArr = JSON.parse(ragResult.additionalContents);
        } catch (e) {
          console.warn(
            'RAG additionalContents is not valid JSON string, defaulting to [].',
            ragResult.additionalContents
          );
          additionalContentsArr = [];
        }
      } else {
        additionalContentsArr = ragResult?.additionalContents || [];
      }

      const responseTimestamp = new Date().toISOString();

      // Log usage in AI engine
      await logUsageToAiEngine(req, {
        category,
        startTime,
        isDeterministic: false,
        conversationId,
        messageId,
        userId: user_id
      });

      // Return flat, primitive-only structure for CDS/OData V4
      return {
        role: completionObj.role,
        content: completionObj.content,
        messageTime: responseTimestamp,
        messageId: messageId || null,
        additionalContents: JSON.stringify(additionalContentsArr)
      };
    } catch (error) {
      console.error('Error while generating response for user query:', error);
      // Let CAP convert this to a 500 for the UI
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
      path: '/getConversationHistory', // action on AIEngineService
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
