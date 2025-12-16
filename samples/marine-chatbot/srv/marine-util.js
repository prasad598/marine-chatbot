const cds = require("@sap/cds")
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

AUTHORIZATION_HEADER = cds.env.requires["SUCCESS_FACTORS_CREDENTIALS"]["AUTHORIZATION_HEADER"]

function extractXmlValue(xmlString, tagName) {
    if (!xmlString) {
        return "";
    }
    const text = typeof xmlString === "string" ? xmlString : xmlString?.toString?.() || "";
    const regex = new RegExp(`<d:${tagName}>([\\s\\S]*?)<\\/d:${tagName}>`, 'i');
    const match = regex.exec(text);
    return match ? match[1].trim() : "";
}

function parsePdfStatusResponse(rawPayload) {
    let payload = rawPayload;

    if (Buffer.isBuffer(payload)) {
        payload = payload.toString("utf8");
    }

    const normalizeJsonPayload = (data) => {
        const node = data?.d ?? data;
        return {
            status: node?.EStatus || node?.status || "",
            message: node?.EStatusMessage || node?.message || ""
        };
    };

    if (payload && typeof payload === "object") {
        const { status, message } = normalizeJsonPayload(payload);
        if (status) {
            return { status, message };
        }
    }

    if (typeof payload === "string") {
        const trimmedPayload = payload.trim();
        if (trimmedPayload.startsWith("{") || trimmedPayload.startsWith("[")) {
            try {
                const parsedJson = JSON.parse(trimmedPayload);
                const { status, message } = normalizeJsonPayload(parsedJson);
                if (status) {
                    return { status, message };
                }
            } catch (error) {
                cds?.log?.warn?.("Failed to parse invoice status JSON payload", error);
            }
        }

        const status = extractXmlValue(trimmedPayload, "EStatus");
        const message = extractXmlValue(trimmedPayload, "EStatusMessage");
        if (status) {
            return { status, message };
        }
        return {
            status: "E",
            message: message || "Unable to process the validation response."
        };
    }

    return {
        status: "E",
        message: "Unable to process the validation response."
    };
}

function normalizeDateToYyyymmdd(asOfDate) {
    if (!asOfDate && asOfDate !== 0) {
        return "";
    }
    const rawValue = `${asOfDate}`.trim();
    if (!rawValue) {
        return "";
    }

    const sanitizedValue = rawValue
        .replace(/\s*([-.\/])\s*/g, '$1')
        .replace(/\s{2,}/g, ' ') // collapse multiple spaces between words
        .trim();

    if (/^\d{8}$/.test(sanitizedValue)) {
        return sanitizedValue;
    }

    if (/^\d{4}[-/.]\d{2}[-/.]\d{2}$/.test(sanitizedValue)) {
        return sanitizedValue.replace(/[-./]/g, "");
    }

    if (/^\d{2}[-/.]\d{2}[-/.]\d{4}$/.test(sanitizedValue)) {
        const parts = sanitizedValue.split(/[-.\/]/);
        const [day, month, year] = parts;
        return `${year}${month}${day}`;
    }

    if (/^\d{2}[-/.][A-Za-z]{3}[-/.]\d{4}$/.test(sanitizedValue)) {
        const parsedDate = new Date(sanitizedValue);
        if (!isNaN(parsedDate.getTime())) {
            const year = parsedDate.getFullYear();
            const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
            const day = String(parsedDate.getDate()).padStart(2, '0');
            return `${year}${month}${day}`;
        }
        return "";
    }

    const parsedDate = new Date(sanitizedValue);
    if (!isNaN(parsedDate.getTime())) {
        const year = parsedDate.getFullYear();
        const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
        const day = String(parsedDate.getDate()).padStart(2, '0');
        return `${year}${month}${day}`;
    }

    if (/^\d{8}$/.test(rawValue)) {
        return rawValue;
    }

    return "";
}

const DATASPHERE_CUSTOMER_PATH = "api/v1/datasphere/consumption/relational/GROUP_IT_SAP/4GV_FF_S_FI_OTCKPI_01/_4GV_FF_S_FI_OTCKPI_01";

function parseCustomerAnalyticsQuery(analyticsQuery) {
    const queryText = (analyticsQuery || "").toString().trim();

    const isBottomQuery = /(bottom|worst|bad|delayed)/i.test(queryText);
    const rankingType = isBottomQuery ? "bottom" : "top";
    const orderDirection = isBottomQuery ? "desc" : "asc";

    let limit = 5;
    const explicitTopMatch = queryText.match(/(?:top|bottom|best|worst|bad|delayed|on\s*-?time)\s*(\d{1,3})/i);
    const numericMentionMatch = queryText.match(/(\d{1,3})\s*customers?/i);
    const limitMatch = explicitTopMatch || numericMentionMatch;
    const limitProvided = Boolean(limitMatch);
    if (limitMatch) {
        const parsedLimit = parseInt(limitMatch[1], 10);
        if (!Number.isNaN(parsedLimit) && parsedLimit > 0) {
            limit = parsedLimit;
        }
    }

    const hasCrossLob = /(cross[-\s]*lob|across\s+all\s+(?:lines?\s+of\s+business|lobs?)|across\s+lobs?)/i.test(queryText);
    let clientFilter = "Aerospace 288";
    if (hasCrossLob) {
        clientFilter = "";
    } else if (/(\belect\b|electronics?\s*288)/i.test(queryText)) {
        clientFilter = "Electronics 288";
    } else if (/aero/i.test(queryText)) {
        clientFilter = "Aerospace 288";
    }

    return {
        orderDirection,
        rankingType,
        limit,
        clientFilter,
        hasCrossLob,
        limitProvided
    };
}

function buildDatasphereQuery({ orderDirection, limit, clientFilter }) {
    const queryParts = [];
    if (clientFilter) {
        queryParts.push(`$filter=${encodeURIComponent(`Client eq '${clientFilter}'`)}`);
    }
    queryParts.push(`$orderby=${encodeURIComponent(`Average_Customer_Payment_Days ${orderDirection}`)}`);
    queryParts.push("$count=true");
    queryParts.push(`$top=${limit}`);
    queryParts.push("$skip=0");

    return `${DATASPHERE_CUSTOMER_PATH}?${queryParts.join("&")}`;
}

function extractCustomerInsights(data) {
    const records = Array.isArray(data?.value)
        ? data.value
        : Array.isArray(data?.d?.results)
            ? data.d.results
            : Array.isArray(data)
                ? data
                : [];

    return records.map((entry, index) => {
        const customerName = entry?.CustomerName
            || entry?.Customer
            || entry?.Customer_Name
            || entry?.CUSTOMER
            || entry?.CustomerDescription
            || "Unknown Customer";
        const paymentDays = entry?.Average_Customer_Payment_Days
            ?? entry?.AverageCustomerPaymentDays
            ?? entry?.AvgPaymentDays
            ?? entry?.AveragePaymentDays
            ?? entry?.Averagecustomerpaymentdays
            ?? null;

        return {
            position: index + 1,
            customerName,
            averageCustomerPaymentDays: paymentDays,
            raw: entry
        };
    });
}

async function getCustomerDataFromDatasphere(analyticsQuery){
    const queryDetails = parseCustomerAnalyticsQuery(analyticsQuery);
    const formattedURL = buildDatasphereQuery(queryDetails);
    try {
        console.log("STE-GPT-INFO getCustomerDataFromDatasphere formattedURL " + formattedURL);
        const response = await executeHttpRequest(
            {
                destinationName: 'datasphere_ap11_qas'
            }, {
                method: 'GET',
                url: formattedURL
            }
        );
        console.log("STE-GPT-INFO getCustomerDataFromDatasphere status- " + response?.status);
        console.log("STE-GPT-INFO getCustomerDataFromDatasphere data " + JSON.stringify(response?.data));

        const customerInsights = extractCustomerInsights(response?.data);
        const customerHighlights = customerInsights.map((item) => {
            const paymentText = item.averageCustomerPaymentDays === null || item.averageCustomerPaymentDays === undefined
                ? "N/A"
                : `${item.averageCustomerPaymentDays} days`;
            return `${item.position}. ${item.customerName} - ${paymentText}`;
        });
        const scopeDescription = queryDetails.clientFilter ? `within the ${queryDetails.clientFilter} client` : "across all lines of business";
        const rankingDescription = `${queryDetails.rankingType} ${queryDetails.limit}`;
        const customerWord = queryDetails.limit === 1 ? "customer" : "customers";
        const limitNote = queryDetails.limitProvided ? "" : " (defaulted to 5 due to unspecified limit)";
        const summary = `Analyzed the ${rankingDescription} ${customerWord}${limitNote} ${scopeDescription} based on Average Customer Payment Days.`;

        return {
            data: response?.data,
            formattedURL,
            appliedParameters: queryDetails,
            analysis: {
                summary,
                scopeDescription,
                rankingDescription,
                rankingType: queryDetails.rankingType,
                orderDirection: queryDetails.orderDirection,
                limit: queryDetails.limit,
                clientFilter: queryDetails.clientFilter,
                limitProvided: queryDetails.limitProvided,
                customerInsights,
                customerHighlights
            }
        };
    } catch (e) {
        console.error("STE-GPT-ERROR getCustomerDataFromDatasphere" + e);
        throw e;
    }
}

// Returns the download link for the provided invoice number
async function getDownloadlink(invoiceNumber){
    const trimmedInvoice = (invoiceNumber || "").toString().trim();

    let formattedURL = "";

    if (trimmedInvoice.length >= 5) {
        const fiscalYearPrefix = trimmedInvoice.substring(1, 3);
        const fiscalYear = `20${fiscalYearPrefix}`;
        const companyCode = trimmedInvoice.substring(3, 6);
        const docNumber = `${trimmedInvoice}`;

        formattedURL = `/sap/opu/odata/sap/ZFI_OTC_FORM_INVOICE_PDF_SRV/get_pdfSet(IBlart='RI',ICompany='${companyCode}',IDocno='${docNumber}',IFiscalYear='${fiscalYear}',ISystemAlias='AERO288')/$value`;
    }
    try {
        console.log("STE-GPT-INFO getDownloadlink formattedURL"+formattedURL+" invoiceNumber="+invoiceNumber);
        const response = await executeHttpRequest(
            {
                destinationName: 'sthubsystem-qa-new'
            }, {
                method: 'GET',
                url: formattedURL,
                responseType: 'arraybuffer'
            }
        );
        console.log("STE-GPT-INFO getDownloadlink status- "+response?.status);
    } catch (e) {
        console.error("STE-GPT-ERROR getDownloadlink"+e);
    }

    return { downloadUrl: formattedURL };
}

async function validateInvoiceAvailability(invoiceNumber) {
    const trimmedInvoice = (invoiceNumber || "").toString().trim();
    if (!trimmedInvoice) {
        return { status: "", message: "", companyCode: "", fiscalYear: "" };
    }

    if (trimmedInvoice.length < 6) {
        return {
            status: "E",
            message: "Unable to derive the required details from the provided invoice number.",
            companyCode: "",
            fiscalYear: ""
        };
    }

    const fiscalYearPrefix = trimmedInvoice.substring(1, 3);
    const fiscalYear = `20${fiscalYearPrefix}`;
    const companyCode = trimmedInvoice.substring(3, 6);
    const docNumber = `${trimmedInvoice}`;

    const formattedURL = `/sap/opu/odata/sap/ZFI_OTC_FORM_INVOICE_PDF_SRV/get_pdfstatusSet(IBlart='RI',ICompany='${companyCode}',IDocno='${docNumber}',IFiscalYear='${fiscalYear}',ISystemAlias='AERO288')`;

    try {
        console.log("STE-GPT-INFO validateInvoiceAvailability request", formattedURL);
        const response = await executeHttpRequest(
            {
                destinationName: 'sthubsystem-qa-new'
            }, {
                method: 'GET',
                url: formattedURL,
                responseType: 'text'
            }
        );
        console.log("STE-GPT-INFO validateInvoiceAvailability status", response?.status);
        if (response?.data !== undefined) {
            console.log("STE-GPT-INFO validateInvoiceAvailability body", response.data);
        }
        const parsed = parsePdfStatusResponse(response?.data);
        return {
            status: parsed.status,
            message: parsed.message,
            companyCode,
            fiscalYear
        };
    } catch (error) {
        console.error("STE-GPT-ERROR validateInvoiceAvailability", error);
        return {
            status: "E",
            message: "Unable to validate the invoice number at this time. Please try again later.",
            companyCode,
            fiscalYear
        };
    }
}

async function getStatementOfAccountLink(companyCode, customerCode, asOfDate) {
    const trimmedCompanyCode = (companyCode || "").toString().trim();
    const trimmedCustomerCode = (customerCode || "").toString().trim();
    const formattedDate = normalizeDateToYyyymmdd(asOfDate);

    let formattedURL = "";

    if (trimmedCompanyCode && trimmedCustomerCode && formattedDate) {
        formattedURL = `/sap/opu/odata/sap/ZFI_AR_SOA_FORM_SRV/get_pdfSet(ICompany='${trimmedCompanyCode}',ICustomer='${trimmedCustomerCode}',IOpendate='${formattedDate}',ISystemAlias='AERO288')/$value`;
        try {
            console.log("STE-GPT-INFO getStatementOfAccountLink formattedURL" + formattedURL);
            await executeHttpRequest(
                {
                    destinationName: 'sthubsystem-qa-new'
                }, {
                    method: 'GET',
                    url: formattedURL,
                    responseType: 'arraybuffer'
                }
            );
        } catch (e) {
            console.error("STE-GPT-ERROR getStatementOfAccountLink" + e);
        }
    }

    return { downloadUrl: formattedURL, formattedDate };
}

async function validateStatementOfAccount(companyCode, customerCode, asOfDate) {
    const trimmedCompanyCode = (companyCode || "").toString().trim();
    const trimmedCustomerCode = (customerCode || "").toString().trim();
    const formattedDate = normalizeDateToYyyymmdd(asOfDate);

    if (!trimmedCompanyCode || !trimmedCustomerCode || !formattedDate) {
        return {
            status: "",
            message: "",
            formattedDate
        };
    }

    const formattedURL = `/sap/opu/odata/sap/ZFI_AR_SOA_FORM_SRV/get_pdfstatusSet(ICompany='${trimmedCompanyCode}',ICustomer='${trimmedCustomerCode}',IOpendate='${formattedDate}',ISystemAlias='AERO288')`;

    try {
        const response = await executeHttpRequest(
            {
                destinationName: 'sthubsystem-qa-new'
            }, {
                method: 'GET',
                url: formattedURL,
                responseType: 'text'
            }
        );
        const parsed = parsePdfStatusResponse(response?.data);
        return {
            status: parsed.status,
            message: parsed.message,
            formattedDate
        };
    } catch (error) {
        console.error("STE-GPT-ERROR validateStatementOfAccount" + error);
        return {
            status: "E",
            message: "Unable to validate the provided customer details at this time. Please try again later.",
            formattedDate
        };
    }
}


// Returns the user object with same structure as we get from SF API
async function getUserInfoById(filterQuery){
    try {
        
        const formattedURL= "/sap/opu/odata/sap/ZFI_OTC_CREDITNOTE_SRV;mo/GetInvoiceSearchResult?sap-client=888&"+filterQuery+"&SAP__Origin='AERO288'&skip=0&top=5&$format=json";
        console.log("STE-GPT-INFO formattedURL"+formattedURL);
        const response = await executeHttpRequest(
            {
                destinationName: 'sthubsystem-qa-new'
            }, {
                method: 'GET',
                url: formattedURL,
                data: {}
            } 
        );
        console.log("STE-GPT-INFO count - "+response.data.d.results.length);
        return response.data.d.results;
    } catch (e) {
        console.error("STE-GPT-ERROR getInvoiceSearchResult"+e);
    }
}



// Returns the user object with same structure as we get from SF API
async function getUserInfoById1(userId){
    try {
    const destination_sf = await cds.connect.to('sthubsystem-qa')
    let result = await destination_sf.send({ 
        query: `GET /sap/opu/odata/sap/ZFI_OTC_CREDITNOTE_SRV;mo/GetInvoiceSearchResult?sap-client=888&InvoiceNo=''&InvoiceType='FI'&FiscalYear='2024'&DateFrom=''&DateTo=''&SalesOrder=''&CompanyCode='801'&SAP__Origin='AERO288'?$format=json`, 
        headers: { Authorization: AUTHORIZATION_HEADER } 
    })
   }catch (e) {
    console.log("call failed error PRASAD-100 getUserInfoById1"+e);
    console.error(e);
}
    // if(result){
    //     return result.d
    // }
    // else return null
}

async function getUserManagerId(userId){
    const destination_sf = await cds.connect.to('destination_sf')
    let result = await destination_sf.send({ 
        query: `GET /odata/v2/User('${userId}')/manager?$format=json`, 
        headers: { Authorization: AUTHORIZATION_HEADER } 
    })
    if(result?.d?.userId){
        return result.d?.userId
    }
    else{
        return null
    }
}

async function getDirectReportsById(userId){
    const destination_sf = await cds.connect.to('destination_sf')
    let result = await destination_sf.send({ 
        query: `GET /odata/v2/User?$filter=manager/userId eq '${userId}'&$format=JSON`, 
        headers: { Authorization: AUTHORIZATION_HEADER } 
    })
    
    if(result?.d?.results){
        let resArr = []
        for (i of result.d.results) {
            resArr.push({
                userId : i.userId,
                displayName : i.displayName
            })
        }
        return resArr
    }
    else return []
}

// Just for datetime value from SF API

async function getEmployeeTime(
    userId,
    displayName,
    startDate, //2024-03-10T00:00:00
    endDate, //2024-03-10T00:00:00
    approvalStatus = 'CANCELLED', 
    approvalStatusOperator = 'ne', 
    timeType = 'TT_VAC_REC'
){
    const destination_sf = await cds.connect.to('destination_sf')
    let result = await destination_sf.send({ 
        query: `GET /odata/v2/EmployeeTime?&$format=json&$filter=userId eq '${userId}' and approvalStatus ${approvalStatusOperator} '${approvalStatus}' and startDate gt datetime'${startDate}' and endDate lt datetime'${endDate}' and timeType eq '${timeType}'`, 
        headers: { Authorization: AUTHORIZATION_HEADER } 
    })
    if(result?.d?.results){

        let resObj = {
            userId: userId,
            displayName: displayName,
            vacations: []
        }
        console.log(displayName)
        for(i of result.d.results){
            if(i.absenceDurationCategory == 'MULTI_DAY'){
                console.log(i.startDate)
                console.log(i.endDate)
                resObj.vacations.push({
                    startDate: i.startDate.substr(6, i.startDate.length - 8),
                    endDate: i.endDate.substr(6, i.endDate.length - 8)
                })

            }
            else{
                //same code just in case we have diff logic after
                resObj.vacations.push({
                    startDate: i.startDate.substr(6, i.startDate.length - 8),
                    endDate: i.endDate.substr(6, i.endDate.length - 8)
                })
            }
        }
        return resObj
    }
    else return null
}

async function getPeersVacationTimeByUserId(
    userId,
    startDate, //2024-03-10T00:00:00
    endDate, //2024-03-10T00:00:00
    noOfDatesToExtend, //before startDate and after endDate
    approvalStatus = 'CANCELLED', 
    approvalStatusOperator = 'ne', 
    timeType = 'TT_VAC_REC'
){
    let managerId = await getUserManagerId(userId)
    let peers = await getDirectReportsById(managerId)

    let dt_startDate = new Date(Date.parse(startDate))
    let changed_dt_startDate = dt_startDate.setDate(dt_startDate.getDate() - noOfDatesToExtend)
    let dt_endDate = new Date(Date.parse(endDate))
    let changed_dt_endDate = dt_endDate.setDate(dt_endDate.getDate() + noOfDatesToExtend)

    let startDate_lc = timestampToString(changed_dt_startDate)
    let endDate_lc = timestampToString(changed_dt_endDate)

    if(peers){

        let resArr = []

        for(i of peers){
            let timeobj = await getEmployeeTime(
                i.userId,
                i.displayName,
                startDate_lc,
                endDate_lc,
                approvalStatus, 
                approvalStatusOperator, 
                timeType
            )
            resArr.push(timeobj)
        }

        return resArr
    }
    else return []
    
}

function timestampToString(timestamp) {
    // Create a new Date object with the timestamp (in milliseconds)
    const date = new Date(timestamp);
    // Get the year, month, day, hours, minutes, and seconds
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0'); // Month is zero-indexed
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const seconds = String(date.getSeconds()).padStart(2, '0');

    // Create the formatted string
    const formattedString = `${year}-${month}-${day}T${hours}:${minutes}:${seconds}`;

    return formattedString;
}

module.exports = { getCustomerDataFromDatasphere, getDownloadlink, getStatementOfAccountLink, getUserInfoById, getUserManagerId, getDirectReportsById, getEmployeeTime, getPeersVacationTimeByUserId, validateInvoiceAvailability, validateStatementOfAccount };
