'use strict';

const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const DESTINATION = 'sthubsystem-qa';
const SYSTEM_ALIAS = 'MRNE188';
const STATUS_PATH = '/ptp';

function formatRawLogData(data) {
  if (data === undefined) {
    return data;
  }

  if (Buffer.isBuffer(data)) {
    return data.toString('utf8');
  }

  if (typeof data === 'string') {
    return data;
  }

  return JSON.stringify(data);
}

async function callStatusService(path) {
  console.log('[MARINE] Calling status service', { destination: DESTINATION, url: path });

  try {
    const response = await executeHttpRequest(
      { destinationName: DESTINATION },
      {
        method: 'GET',
        url: path
      }
    );

    console.log('[MARINE] Status service success', { httpStatus: response?.status });
    console.log('[MARINE] Status service raw response', formatRawLogData(response?.data));

    return response?.data || null;
  } catch (error) {
    console.error('[MARINE] Status service FAILED', {
      destination: DESTINATION,
      url: path,
      message: error?.message,
      status: error?.response?.status,
      responseData: formatRawLogData(error?.response?.data)
    });
    return null;
  }
}

function normalizeStatusResponse(data) {
  let normalizedData = data;

  if (typeof data === 'string') {
    try {
      normalizedData = JSON.parse(data);
    } catch (error) {
      normalizedData = data;
    }
  }

  const poItems = Array.isArray(normalizedData?.poItems) ? normalizedData.poItems : [];
  const prItems = Array.isArray(normalizedData?.prItems) ? normalizedData.prItems : [];
  const invoiceItems = Array.isArray(normalizedData?.invoiceItems)
    ? normalizedData.invoiceItems
    : Array.isArray(normalizedData?.invoices)
      ? normalizedData.invoices
      : [];
  const hasItems = poItems.length > 0 || prItems.length > 0 || invoiceItems.length > 0;
  const success = normalizedData?.success === true;
  const totalCount = Number.isFinite(normalizedData?.totalCount)
    ? normalizedData.totalCount
    : Number(normalizedData?.totalCount);
  const resultCount = Number.isFinite(normalizedData?.resultCount)
    ? normalizedData.resultCount
    : Number(normalizedData?.resultCount);
  const message =
    normalizedData?.success === true && !hasItems && Number.isNaN(totalCount)
      ? 'No matching documents found.'
      : normalizedData?.message || '';

  return {
    success,
    message,
    searchValues: Array.isArray(normalizedData?.searchValues) ? normalizedData.searchValues : [],
    totalCount: Number.isNaN(totalCount) ? null : totalCount,
    resultCount: Number.isNaN(resultCount) ? null : resultCount,
    poItems,
    prItems,
    invoiceItems,
    raw: normalizedData
  };
}

function buildQueryParams(params) {
  const entries = Object.entries(params || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [key, String(value)]);

  entries.push(['ISystemAlias', SYSTEM_ALIAS]);

  const encodeQueryValue = (value) => encodeURIComponent(value).replace(/%2C/g, ',');

  return entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeQueryValue(value)}`)
    .join('&');
}

async function getDocumentStatus({ docType, numbers }) {
  if (!docType || !numbers || numbers.length === 0) {
    return {
      success: false,
      message: 'Document type or number missing',
      poItems: [],
      prItems: [],
      invoiceItems: [],
      raw: null
    };
  }

  const trimmedNumbers = numbers.filter(Boolean).map((value) => String(value).trim()).filter(Boolean);
  if (trimmedNumbers.length === 0) {
    return {
      success: false,
      message: 'Document number missing',
      poItems: [],
      prItems: [],
      invoiceItems: [],
      raw: null
    };
  }

  const docParamMap = {
    PO: 'PurchaseOrder',
    PR: 'PurchaseRequisition',
    INV: 'Invoice'
  };

  const docParam = docParamMap[docType];
  if (!docParam) {
    return {
      success: false,
      message: 'Unsupported document type',
      poItems: [],
      prItems: [],
      invoiceItems: [],
      raw: null
    };
  }

  const fetchForDocType = async (requestedDocType) => {
    const query = buildQueryParams({
      [docParamMap[requestedDocType]]: trimmedNumbers.join(',')
    });
    const url = `${STATUS_PATH}?${query}`;
    const data = await callStatusService(url);

    if (!data) {
      return {
        success: false,
        message: 'No response from backend service',
        poItems: [],
        prItems: [],
        invoiceItems: [],
        raw: null
      };
    }

    return normalizeStatusResponse(data);
  };

  const primaryResponse = await fetchForDocType(docType);
  const primaryHasItems =
    (primaryResponse?.poItems || []).length > 0 ||
    (primaryResponse?.prItems || []).length > 0 ||
    (primaryResponse?.invoiceItems || []).length > 0;

  if (primaryHasItems || !['PR', 'PO'].includes(docType)) {
    return primaryResponse;
  }

  const fallbackDocType = docType === 'PR' ? 'PO' : 'PR';
  const fallbackResponse = await fetchForDocType(fallbackDocType);
  const fallbackHasItems =
    (fallbackResponse?.poItems || []).length > 0 ||
    (fallbackResponse?.prItems || []).length > 0 ||
    (fallbackResponse?.invoiceItems || []).length > 0;

  return fallbackHasItems ? fallbackResponse : primaryResponse;
}

async function searchDocuments(filters = {}) {
  const query = buildQueryParams({
    DateFrom: filters.dateFrom,
    DateTo: filters.dateTo,
    DocType: filters.docType,
    Creator: filters.creator,
    Approver: filters.approver,
    PaymentStatus: filters.paymentStatus,
    CostCenter: filters.costCenter,
    WBS: filters.wbs,
    GLAccount: filters.glAccount,
    Vendor: filters.vendor,
    $top: filters.top,
    $skip: filters.skip,
    count: filters.count ? 'X' : ''
  });

  const url = `${STATUS_PATH}?${query}`;
  const data = await callStatusService(url);

  if (!data) {
    return {
      success: false,
      message: 'No response from backend service',
      poItems: [],
      prItems: [],
      invoiceItems: [],
      raw: null
    };
  }

  return normalizeStatusResponse(data);
}

module.exports = {
  getDocumentStatus,
  searchDocuments
};
