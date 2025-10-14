const cds = require('@sap/cds');
const { DELETE } = cds.ql;
const sf_connection_util = require("./sf-connection-util")
const { handleMemoryBeforeRagCall, handleMemoryAfterRagCall } = require('./memory-helper');

userId = cds.env.requires["SUCCESS_FACTORS_CREDENTIALS"]["USER_ID"]

const tableName = 'SAP_TISCE_DEMO_DOCUMENTCHUNK'; 
const embeddingColumn  = 'EMBEDDING'; 
const contentColumn = 'TEXT_CHUNK';

const systemPrompt =
`Your task is to classify the user question into either of the four categories: invoice-request-query, download-invoice, customer-analytics or generic-query\n


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
    "invoiceNumber" : "invoice number provided by the user in 10 digit format"
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
a. ensure invoice number is returned as 10 digit value. add leading zeros if required.
b. if user input does not have an invoice number respond with invoiceNumber as empty string.


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


Rules: \n
1. Ask follow up questions for company code  \n

 EXAMPLE5:


 user input:  Can I get invoices posted or created this year under 808 comapny code?
 response:  {
     "category" : "invoice-request-query"
     "query: "InvoiceNo=''&InvoiceType='FI'&FiscalYear='2024'&DateFrom='01.01.2024'&DateTo='31.12.2024'&SalesOrder=''&CompanyCode='808'"
    }


Rules: \n
If the invoice search list {} or empty or undefined , then instruct the user to provide revised search criteria.\n






EXAMPLE6:


user input:  Can I get invoices posted or created last year ?
ask for follow up question on company code and feed user input company code in query.


Rules: \n
1. Ask follow up questions for company code  \n
if the user proivdes 898 \n


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
Rules: \n
1. Ask follow up questions if you need additional  \n
2. make InvoiceNo as 10 digit example in this case 0248013075 \n
3. in this invoiceNo , year will be 24 ( first two chars) which is 2024, company code wil be 801 (char 3 + char 4 +char 5) \n




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


`
const hrRequestPrompt =
`You are a chatbot. Answer the user question based on the following information

1. Invoice search policy , delimited by triple backticks. \n 
2. If there are any invoice specific invoice detetais guidelies in the Invoice Policy , Consider the invoice details and check the invoice search list .\n

Invoice search list details \n

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

\n

Rules: \n 
1. Ask follow up questions if you need additional information from user to answer the question.\n 
2. If the invoice search list {} or empty or undefined , then instruct the user to provide optimized search criteria.\n
3. Note that invoice and AccountDocument are alias names , always return response as invoice \n
4. Be more formal in your response. \n
5. Keep the answers concise. \n
6. Alwasy return some response with proper instructions to user. \n
`
;

const genericRequestPrompt =
'You are a chatbot. Answer the user question based only on the context, delimited by triple backticks\n ';

const downloadRequestPrompt =
`You are a chatbot. Use the provided context, delimited by triple backticks, to support invoice download requests.\n
Context includes:\n
1. invoiceNumber\n
2. downloadUrl\n
Rules:\n
1. If invoiceNumber is empty ask the user to kindly provide the invoice number required for the download.\n
2. When invoiceNumber is provided, respond using exactly the following XML structure with no additional text or punctuation:\n
<href>{invoiceNumber}</href>\n\n<href-value>{downloadUrl}</href-value>\n
3. Keep the tone formal and concise.\n`;


const soaRequestPrompt =
`You are a chatbot. Use the provided context, delimited by triple backticks, to support Statement of Account (SOA) requests.\n
Context includes:\n
1. companyCode\n
2. customerCode\n
3. asOfDate\n
4. formattedDate\n
5. downloadUrl\n
Rules:\n
1. If any of companyCode, customerCode, or formattedDate is empty, politely ask the user to provide the missing information.\n
2. When all required details are present and downloadUrl is available, respond using exactly the following XML structure with no additional text or punctuation:\n
<href>StatementOfAccount</href>\n\n<href-value>{downloadUrl}</href-value>\n
3. Keep the tone formal and concise.\n`;


const customerAnalyticsPrompt =
`You are a chatbot. Use the provided context, delimited by triple backticks, to answer customer analytics questions.\n
Context includes:\n
1. The original customer analytics question.\n
2. Customer analytics data retrieved from the Datasphere service.\n
Rules:\n
1. Summarize the returned analytics data in a clear and concise manner.\n
2. If the data is empty, inform the user that no customer analytics data is available and suggest refining the question.\n
3. Keep the tone formal and professional.\n`;


const taskCategory = {
    "invoice-request-query" : hrRequestPrompt,
    "generic-query" : genericRequestPrompt,
    "download-invoice" : downloadRequestPrompt,
    "customer-analytics" : customerAnalyticsPrompt,
    "soa-request" : soaRequestPrompt
}

function getFormattedDate (timeStamp)
{
    const timestamp = Number(timeStamp);
    const date = new Date(timestamp);
    return new Intl.DateTimeFormat('en-US', {
        timeZone: 'GMT',
      }).format(date);
}




module.exports = function () {

    this.on('getChatRagResponse', async (req) => {
        try {
            console.log("module.exports getChatRagResponse start Prasad"+req.data);
            //request input data
            const { conversationId, messageId, message_time, user_id, user_query } = req.data;
            const { Conversation, Message } = this.entities;
            const vectorplugin = await cds.connect.to("cap-llm-plugin");

            let determinationPayload = [{
                "role" : "system",
                "content" : `${systemPrompt}`
              }];

            const userQuestion = [
                {
                  "role": "user",
                  "content": `${user_query}`
                }
              ]
            
            determinationPayload.push(...userQuestion);
            let payload = {
                "messages": determinationPayload
            };

            const determinationResponse = await vectorplugin.getChatCompletion(payload)
            console.log("STE-GPT-INFO determinationResponse "+determinationResponse);
            const determinationJson = JSON.parse(determinationResponse.content);
            const category = determinationJson?.category ;
            
            
            console.log("STE-GPT-INFO determinationJson "+JSON.stringify(determinationJson));

            if (! taskCategory.hasOwnProperty(category)) {
                throw new Error(`${category} is not in the supported`);
              }

            const promptResponses = {
                "invoice-request-query": hrRequestPrompt,
                "generic-query": genericRequestPrompt,
                "download-invoice": downloadRequestPrompt,
                "customer-analytics": customerAnalyticsPrompt,
                "soa-request": soaRequestPrompt
            };

            if (category === "invoice-request-query")
            {

                //Comment1 Start by Prasad April 17, 11:45PM
                // const [startDateStr, endDateStr] = determinationJson?.dates?.split('-');
                const filterQuery = determinationJson?.query ;
                let dataInvoiceList = await sf_connection_util.
                getUserInfoById(
                    filterQuery
                );
                
                // Comment1 End by Prasad April 17, 11:45PM
                //const teamLeaveDates = {}
                //Comment2 Start by Prasad April 17, 11:45PM
                // data.forEach(item => {
                //     const formattedData = [];
                //     item.vacations.forEach(vacation => {

                //         formattedData.push([getFormattedDate (vacation.startDate), getFormattedDate (vacation.endDate) ]);
                //     });
                //     if ( formattedData.length > 0 ) { teamLeaveDates[item.displayName] = formattedData; }
                // });
                // Comment2 End by Prasad April 17, 11:45PM



                const teamLeaveDataString = JSON.stringify(dataInvoiceList);

                promptResponses["invoice-request-query"] = hrRequestPrompt + ` \`\`${teamLeaveDataString}\`\` \n`
            }

            if (category === "download-invoice")
            {
                const rawInvoiceNumber = determinationJson?.invoiceNumber;
                let invoiceNumber = "";
                if (rawInvoiceNumber !== undefined && rawInvoiceNumber !== null) {
                    const parsedInvoiceNumber = `${rawInvoiceNumber}`.trim();
                    const digitsOnlyInvoiceNumber = parsedInvoiceNumber.replace(/\D/g, "");
                    if (digitsOnlyInvoiceNumber.length > 0) {
                        invoiceNumber = digitsOnlyInvoiceNumber.padStart(10, '0');
                    }
                }

                if (invoiceNumber) {
                    let downloadLinkResponse = await sf_connection_util.getDownloadlink(
                        invoiceNumber
                    );
                    const downloadUrl = downloadLinkResponse?.downloadUrl || downloadLinkResponse?.url || "";
                    const downloadContext = { invoiceNumber, downloadUrl };
                    promptResponses["download-invoice"] = downloadRequestPrompt + ` \`\`${JSON.stringify(downloadContext)}\`\` \n`;
                } else {
                    const downloadContext = { invoiceNumber: "", downloadUrl: "" };
                    promptResponses["download-invoice"] = downloadRequestPrompt + ` \`\`${JSON.stringify(downloadContext)}\`\` \n`;
                }
            }

            if (category === "soa-request")
            {
                const companyCode = determinationJson?.companyCode ? `${determinationJson.companyCode}`.trim() : "";
                const customerCode = determinationJson?.customerCode ? `${determinationJson.customerCode}`.trim() : "";
                const asOfDate = determinationJson?.asOfDate ? `${determinationJson.asOfDate}`.trim() : "";
                const soaLinkResponse = await sf_connection_util.getStatementOfAccountLink(
                    companyCode,
                    customerCode,
                    asOfDate
                );
                const soaContext = {
                    companyCode,
                    customerCode,
                    asOfDate,
                    formattedDate: soaLinkResponse?.formattedDate || "",
                    downloadUrl: soaLinkResponse?.downloadUrl || ""
                };
                promptResponses["soa-request"] = soaRequestPrompt + ` \`\`${JSON.stringify(soaContext)}\`\` \n`;
            }

            if (category === "customer-analytics")
            {
                const analyticsQuery = determinationJson?.analyticsQuery || user_query;
                try {
                    const customerAnalyticsResult = await sf_connection_util.getCustomerDataFromDatasphere(analyticsQuery);
                    console.log("STE-GPT-INFO customer analytics response " + JSON.stringify(customerAnalyticsResult));
                    const analyticsContext = {
                        analyticsQuery,
                        serviceResponse: customerAnalyticsResult?.data,
                        serviceUrl: customerAnalyticsResult?.formattedURL,
                        appliedParameters: customerAnalyticsResult?.appliedParameters,
                        analysis: customerAnalyticsResult?.analysis
                    };
                    promptResponses["customer-analytics"] = customerAnalyticsPrompt + ` \`\`${JSON.stringify(analyticsContext)}\`\` \n`;
                } catch (error) {
                    console.error("STE-GPT-ERROR customer analytics service call", error);
                    const analyticsContext = {
                        analyticsQuery,
                        serviceResponse: [],
                        serviceUrl: "",
                        appliedParameters: {},
                        analysis: {
                            summary: "",
                            scopeDescription: "",
                            rankingDescription: "",
                            rankingType: "",
                            orderDirection: "",
                            limit: 0,
                            clientFilter: "",
                            limitProvided: false,
                            customerInsights: [],
                            customerHighlights: []
                        }
                    };
                    promptResponses["customer-analytics"] = customerAnalyticsPrompt + ` \`\`${JSON.stringify(analyticsContext)}\`\` \n`;
                }
            }



            //handle memory before the RAG LLM call
            const memoryContext = await handleMemoryBeforeRagCall (conversationId , messageId, message_time, user_id , user_query, Conversation, Message );
            
            /*Single method to perform the following :
            - Embed the input query
            - Perform similarity search based on the user query 
            - Construct the prompt based on the system instruction and similarity search
            - Call chat completion model to retrieve relevant answer to the user query
            */

            const chatRagResponse = await vectorplugin.getRagResponse(
            // const chatRagResponse = await vectorplugin.getChatCompletionWithConfig(
                user_query,
                tableName,
                embeddingColumn,
                contentColumn,
                promptResponses[category] ,
                memoryContext .length > 0 ? memoryContext : undefined,
                30
            );

            //handle memory after the RAG LLM call
            const responseTimestamp = new Date().toISOString();
            await handleMemoryAfterRagCall (conversationId , responseTimestamp, chatRagResponse.completion, Message, Conversation);

            const response = {
                "role" : chatRagResponse.completion.role,
                "content" : chatRagResponse.completion.content,
                "messageTime": responseTimestamp,
                "additionalContents": chatRagResponse.additionalContents,
            };

            return response;
        }
        catch (error) {
            // Handle any errors that occur during the execution
            console.log('Error while generating response for user query:', error);
            throw error;
        }

    })


    this.on('deleteChatData', async () => {
        try {
            const { Conversation, Message } = this.entities;
            await DELETE.from(Conversation);
            await DELETE.from(Message);
            return "Success!"
        }
        catch (error) {
            // Handle any errors that occur during the execution
            console.log('Error while deleting the chat content in db:', error);
            throw error;
        }
    })

}