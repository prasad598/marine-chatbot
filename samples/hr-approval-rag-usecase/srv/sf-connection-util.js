const cds = require("@sap/cds")
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

AUTHORIZATION_HEADER = cds.env.requires["SUCCESS_FACTORS_CREDENTIALS"]["AUTHORIZATION_HEADER"]

// Returns the download link for the provided invoice number
async function getDownloadlink(invoiceNumber){
    const trimmedInvoice = (invoiceNumber || "").toString().trim();

    let formattedURL = "";

    if (trimmedInvoice.length >= 5) {
        const fiscalYearPrefix = trimmedInvoice.substring(0, 2);
        const fiscalYear = `20${fiscalYearPrefix}`;
        const companyCode = trimmedInvoice.substring(2, 5);
        const docNumber = `0${trimmedInvoice}`;

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

module.exports = { getDownloadlink, getUserInfoById, getUserManagerId, getDirectReportsById, getEmployeeTime, getPeersVacationTimeByUserId };
