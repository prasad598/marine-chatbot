'use strict';

const cds = require('@sap/cds');
const { DELETE, SELECT } = cds.ql;

const marine_util = require('./marine-util');
const {
  normalizeInvoiceNumber,
  extractInvoiceNumberFromText
} = require('./chat-utils');


const PROJECT_NAME = 'MARINE_USECASE';

// ---- CONFIG (same as before) ----
const tableName = 'SAP_TISCE_DEMO_DOCUMENTCHUNK';
const embeddingColumn = 'EMBEDDING';
const contentColumn = 'TEXT_CHUNK';

// ---------------- SYSTEM PROMPT (classifier) ----------------
const systemPrompt = `Your task is to classify the user question into either of the four categories: invoice-request-query, download-invoice, customer-analytics or generic-query

 If the user wants to know the invoice related details with company code, invoice number, posting date ,Customer return the response as json
 with the following format:
 {
    "category" : "invoice-request-query"
    "query: "InvoiceNo='AccountingDocument'&InvoiceType='FI'&FiscalYear='year of invoice posting date'&DateFrom='fromDate'&DateTo='toDate'&SalesOrder=''&CompanyCode='companyCode'"
 }

 If the user wants to download, print or get a link for an invoice provide the response as json
 with the following format:
 {
    "category" : "download-invoice",
    "invoiceNumber" : "invoice digits provided by the user (never leave empty when digits are present)"
 }

 If the user wants to retrieve a Statement of Account (SOA) for a customer provide the response as json
 with the following format:
 {
    "category" : "soa-request",
    "companyCode" : "company code provided by the user",
    "customerCode" : "customer code provided by the user",
    "asOfDate" : "as-of date provided by the user in any recognizable date format"
 }

 For all other queries, return the response as json as follows
 {
    "category" : "generic-query"
 }

 If the user is asking about customer analytics, historical customer performance, payment history, or requests insight such as best or worst customers, return the response as json
 with the following format:
 {
    "category" : "customer-analytics",
    "analyticsQuery": "<restated customer analytics question from the user>"
 }

Rules:

1. If the user does not provide any invoice related information consider it as a generic category.
2. If the category of the user question is "invoice-request-query",
a. if the user does not input exact dates and only mentions year, fill the dates as "[start date of the year]-[end date of the year]".
b. if the user does not input exact dates and only mentions months, fill the dates as "[start date of the month]-[end date of the month]".
c. if the user does not input exact dates and only mentions week, fill the dates as "[start date of the week]-[end date of the week]".

3. If the category of the user question is "download-invoice",
a. always include the invoice number digits supplied by the user. You may add leading zeros to make it ten digits, but never omit the digits entirely.
b. if the user input includes any digits that could represent an invoice number, return those digits (even if fewer than ten) so the service can normalize them; only respond with an empty invoiceNumber when no digits are present.
c. Treat common misspellings of the word invoice (for example: inovice, invioce, invice) as referring to invoices when interpreting the user request.

4. If the category of the user question is "soa-request",
a. if the user does not provide the company code, customer code, or as-of date, set the respective value as an empty string in the response JSON.
b. Capture the as-of date exactly as provided by the user.

EXAMPLES:

EXAMPLE1:

user input: What kind of invoice details can provide ?
response:  {
    "category" : "generic-query"
 }

EXAMPLE2:

user input: Can get invoices between January 1 to January 10 and company code 898?
response:  {
    "category" : "invoice-request-query"
    "query: "InvoiceNo=''&InvoiceType='FI'&FiscalYear='2024'&DateFrom='01.01.2024'&DateTo='10.01.2024'&SalesOrder=''&CompanyCode='898'"
}

EXAMPLE3:

user input:  Can I get invoices posted in in March 2024for company code 801 ?
response:  {
    "category" : "invoice-request-query"
    "query: "InvoiceNo=''&InvoiceType='FI'&FiscalYear='2024'&DateFrom='01.03.2024'&DateTo='31.03.2024'&SalesOrder=''&CompanyCode='801'"
 }

EXAMPLE4:

user input:  Can I get invoices posted or created this week ?

If user provides company code as 803 then
response:  {
    "category" : "invoice-request-query"
    "query: "InvoiceNo=''&InvoiceType='FI'&FiscalYear='2024'&DateFrom='17.04.2024'&DateTo='24.04.2024'&SalesOrder=''&CompanyCode='803'"
 }

Rules: 
1. Ask follow up questions for company code  

 EXAMPLE5:

 user input:  Can I get invoices posted or created this year under 808 comapny code?
 response:  {
     "category" : "invoice-request-query"
     "query: "InvoiceNo=''&InvoiceType='FI'&FiscalYear='2024'&DateFrom='01.01.2024'&DateTo='31.12.2024'&SalesOrder=''&CompanyCode='808'"
    }

Rules: 
If the invoice search list {} or empty or undefined , then instruct the user to provide revised search criteria.

EXAMPLE6:

user input:  Can I get invoices posted or created last year ?
ask for follow up question on company code and feed user input company code in query.

Rules: 
1. Ask follow up questions for company code  
if the user proivdes 898 

response:  {
    "category" : "invoice-request-query"
    "query: "InvoiceNo=''&InvoiceType='FI'&FiscalYear='2023'&DateFrom='01.01.2023'&DateTo='31.12.2023'&SalesOrder=''&CompanyCode='898'"
}

EXAMPLE8:

user input:  Can I get invoice details for invoice 248013075?
response:  {
    "category" : "invoice-request-query"
    "query: "InvoiceNo='0248013075'&InvoiceType='FI'&FiscalYear='2024'&DateFrom=''&DateTo=''&SalesOrder=''&CompanyCode='801'"
}
Rules: 
1. Ask follow up questions if you need additional  
2. make InvoiceNo as 10 digit example in this case 0248013075 
3. in this invoiceNo , year will be 24 ( first two chars) which is 2024, company code wil be 801 (char 3 + char 4 +char 5) 

EXAMPLE9:
user input: Can get invoice search policy ?
response: {
    "category" : "generic-query"
 }

EXAMPLE10:

user input: Please share the download link for invoice 248013029.
response: {
    "category" : "download-invoice"
    "invoiceNumber" : "0248013029"
}

EXAMPLE10A:

user input: Download invoice 123425231.
response: {
    "category" : "download-invoice"
    "invoiceNumber" : "123425231"
}

EXAMPLE11:

user input: I need to download the invoice copy.
response: {
    "category" : "download-invoice"
    "invoiceNumber" : ""
}

EXAMPLE12:

user input: Who has been our best customer in terms of revenue over the last quarter?
response:  {
    "category" : "customer-analytics",
    "analyticsQuery" : "Who has been our best customer in terms of revenue over the last quarter?"
 }

EXAMPLE13:

user input: Show me the payment history details for our top five customers.
response:  {
    "category" : "customer-analytics",
    "analyticsQuery" : "Show me the payment history details for our top five customers."
 }

EXAMPLE14:

user input: Please share the SOA for customer 100252 in company code 808 as of 2nd May 2017.
response:  {
    "category" : "soa-request",
    "companyCode" : "808",
    "customerCode" : "100252",
    "asOfDate" : "2nd May 2017"
 }
`;

// ---------------- CATEGORY PROMPTS (base system prompts) ----------------
const hrRequestPrompt = `You are a chatbot. Answer the user question based on the following information

1. Invoice search policy , delimited by triple backticks.  
2. If there are any invoice specific invoice detetais guidelies in the Invoice Policy , Consider the invoice details and check the invoice search list .

Invoice search list details 

{ 

Example object for invoice details : it should return in ths example format only. rules
remove any special symbols (*,_ etc) generate nice specified format only.
Invoice 1:
Invoice Number: "AccountingDocument" // 248013000
Document Date: "DocumentDate" // 02.01.2024
Posting Date: "PostingDate" // 02.01.2024
Customer: "Customer" // A200007-00
Currency: "Currency"//SGD
Reference Document: "ReferenceDocument"//DA8012312B001176 
}
Invoice 2:
Invoice Number: 248013000
Document Date: 02.01.2024
Posting Date: 02.01.2024
Customer: A200007-00
Currency: SGD
Reference Document: DA8012312B001176 
}
...

Rules:  
1. Ask follow up questions if you need additional information from user to answer the question. 
2. If the invoice search list {} or empty or undefined , then instruct the user to provide optimized search criteria.
3. Note that invoice and AccountDocument are alias names , always return response as invoice 
4. Be more formal in your response. 
5. Keep the answers concise. 
6. Alwasy return some response with proper instructions to user. 
`;

const genericRequestPrompt =
  'You are a chatbot. Answer the user question based only on the context, delimited by triple backticks.';

const downloadRequestPrompt = `You are a chatbot. Use the provided context, delimited by triple backticks, to support invoice download requests.
Context includes:
1. invoiceNumber
2. downloadUrl
3. EStatus
4. EStatusMessage
Rules:
1. If invoiceNumber is empty ask the user to kindly provide the invoice number required for the download.
2. If EStatus equals 'E', respond using exactly the text in EStatusMessage with no additional commentary.
3. When EStatus equals 'S' and downloadUrl is available, respond using exactly the following XML structure with no additional text or punctuation:
<href>{invoiceNumber}</href>

<href-value>{downloadUrl}</href-value>
4. Keep the tone formal and concise.`;

const soaRequestPrompt = `You are a chatbot. Use the provided context, delimited by triple backticks, to support Statement of Account (SOA) requests.
Context includes:
1. companyCode
2. customerCode
3. asOfDate
4. formattedDate
5. downloadUrl
6. EStatus
7. EStatusMessage
Rules:
1. If any of companyCode, customerCode, or formattedDate is empty, politely ask the user to provide the missing information.
2. If EStatus equals 'E', respond using exactly the text in EStatusMessage with no additional commentary.
3. When all required details are present, EStatus equals 'S', and downloadUrl is available, respond using exactly the following XML structure with no additional text or punctuation:
<href>StatementOfAccount</href>

<href-value>{downloadUrl}</href-value>
4. Keep the tone formal and concise.`;

const customerAnalyticsPrompt = `You are a chatbot. Use the provided context, delimited by triple backticks, to answer customer analytics questions.
Context includes:
1. The original customer analytics question.
2. Customer analytics data retrieved from the Datasphere service.
Rules:
1. Summarize the returned analytics data in a clear and concise manner.
2. If the data is empty, inform the user that no customer analytics data is available and suggest refining the question.
3. Keep the tone formal and professional.`;

// Base prompts mapping (category → base system prompt)
const basePrompts = {
  'invoice-request-query': hrRequestPrompt,
  'generic-query': genericRequestPrompt,
  'download-invoice': downloadRequestPrompt,
  'customer-analytics': customerAnalyticsPrompt,
  'soa-request': soaRequestPrompt
};


// ---------------- CATEGORY HANDLERS (project-specific logic) ----------------
const categoryHandlers = {
  // 1) INVOICE SEARCH
  'invoice-request-query': async ({ determinationJson, basePrompt }) => {
    const filterQuery = determinationJson?.query;
    const dataInvoiceList = await marine_util.getUserInfoById(filterQuery);
    const teamLeaveDataString = JSON.stringify(dataInvoiceList);

    return {
      prompt: basePrompt + ` \`\`${teamLeaveDataString}\`\` \n`
      // no deterministic response → RAG will run
    };
  },

  // 2) DOWNLOAD INVOICE
  'download-invoice': async ({ determinationJson, user_query, basePrompt }) => {
    const inferredInvoiceDigits = extractInvoiceNumberFromText(user_query);
    const inferredInvoiceNumber = normalizeInvoiceNumber(inferredInvoiceDigits);
    const classifierInvoiceNumber = normalizeInvoiceNumber(
      determinationJson?.invoiceNumber
    );

    let invoiceNumber = '';
    if (inferredInvoiceNumber) {
      invoiceNumber = inferredInvoiceNumber;
    } else if (classifierInvoiceNumber) {
      invoiceNumber = classifierInvoiceNumber;
    }

    let EStatus = '';
    let EStatusMessage = '';
    let downloadUrl = '';

    if (invoiceNumber) {
      const precheckResponse =
        await marine_util.validateInvoiceAvailability(invoiceNumber);
      console.log(
        'STE-GPT-INFO validateInvoiceAvailability precheck',
        JSON.stringify(precheckResponse)
      );
      EStatus = precheckResponse?.status || '';
      EStatusMessage = precheckResponse?.message || '';
      if (EStatus === 'S') {
        const downloadLinkResponse =
          await marine_util.getDownloadlink(invoiceNumber);
        downloadUrl =
          downloadLinkResponse?.downloadUrl ||
          downloadLinkResponse?.url ||
          '';
      }
    }

    const downloadContext = { invoiceNumber, downloadUrl, EStatus, EStatusMessage };
    console.log('STE-GPT-INFO download-invoice context', {
      query: user_query,
      invoiceNumber,
      EStatus,
      hasDownloadUrl: Boolean(downloadUrl)
    });

    // build deterministic answer if possible
    let deterministic = null;
    if (!invoiceNumber) {
      deterministic = {
        role: 'assistant',
        content: 'Kindly provide the invoice number required for the download.',
        additionalContents: []
      };
    } else if (EStatus === 'E') {
      deterministic = {
        role: 'assistant',
        content: EStatusMessage || 'Invoice not found.',
        additionalContents: []
      };
    } else if (EStatus === 'S' && downloadUrl) {
      deterministic = {
        role: 'assistant',
        content: `<href>${invoiceNumber}</href>\n\n<href-value>${downloadUrl}</href-value>`,
        additionalContents: []
      };
    } else {
      deterministic = {
        role: 'assistant',
        content:
          'Invoice download service is temporarily unavailable. Please try again in a few minutes.',
        additionalContents: []
      };
    }

    return {
      prompt: basePrompt + ` \`\`${JSON.stringify(downloadContext)}\`\` \n`,
      deterministic
    };
  },

  // 3) SOA REQUEST
  'soa-request': async ({ determinationJson, basePrompt }) => {
    const companyCode = determinationJson?.companyCode
      ? `${determinationJson.companyCode}`.trim()
      : '';
    const customerCode = determinationJson?.customerCode
      ? `${determinationJson.customerCode}`.trim()
      : '';
    const asOfDate = determinationJson?.asOfDate
      ? `${determinationJson.asOfDate}`.trim()
      : '';

    let downloadUrl = '';
    let formattedDate = '';
    let EStatus = '';
    let EStatusMessage = '';

    if (companyCode && customerCode && asOfDate) {
      const precheckResponse = await marine_util.validateStatementOfAccount(
        companyCode,
        customerCode,
        asOfDate
      );
      formattedDate = precheckResponse?.formattedDate || '';
      EStatus = precheckResponse?.status || '';
      EStatusMessage = precheckResponse?.message || '';

      if (EStatus === 'S') {
        const soaLinkResponse =
          await marine_util.getStatementOfAccountLink(
            companyCode,
            customerCode,
            asOfDate
          );
        formattedDate = soaLinkResponse?.formattedDate || formattedDate;
        downloadUrl = soaLinkResponse?.downloadUrl || '';
      }
    }

    const soaContext = {
      companyCode,
      customerCode,
      asOfDate,
      formattedDate,
      downloadUrl,
      EStatus,
      EStatusMessage
    };

    return {
      prompt: basePrompt + ` \`\`${JSON.stringify(soaContext)}\`\` \n`
    };
  },

  // 4) CUSTOMER ANALYTICS
  'customer-analytics': async ({ determinationJson, user_query, basePrompt }) => {
    const analyticsQuery = determinationJson?.analyticsQuery || user_query;

    let analyticsContext;
    try {
      const customerAnalyticsResult =
        await marine_util.getCustomerDataFromDatasphere(analyticsQuery);
      console.log(
        'STE-GPT-INFO customer analytics response ' +
          JSON.stringify(customerAnalyticsResult)
      );
      analyticsContext = {
        analyticsQuery,
        serviceResponse: customerAnalyticsResult?.data,
        serviceUrl: customerAnalyticsResult?.formattedURL,
        appliedParameters: customerAnalyticsResult?.appliedParameters,
        analysis: customerAnalyticsResult?.analysis
      };
    } catch (error) {
      console.error('STE-GPT-ERROR customer analytics service call', error);
      analyticsContext = {
        analyticsQuery,
        serviceResponse: [],
        serviceUrl: '',
        appliedParameters: {},
        analysis: {
          summary: '',
          scopeDescription: '',
          rankingDescription: '',
          rankingType: '',
          orderDirection: '',
          limit: 0,
          clientFilter: '',
          limitProvided: false,
          customerInsights: [],
          customerHighlights: []
        }
      };
    }

    return {
      prompt: basePrompt + ` \`\`${JSON.stringify(analyticsContext)}\`\` \n`
    };
  }
};

// -----------------------------------------------------------------------------
// Helper: send usage log to AI engine
// -----------------------------------------------------------------------------


// ---------------------- CAP SERVICE ----------------------
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
        user_query
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

      // 3) If deterministic (download, etc.) → no RAG call
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