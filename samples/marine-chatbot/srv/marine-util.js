'use strict';

const cds = require('@sap/cds');
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const DESTINATION = 'sthubsystem-qa';
const SYSTEM_ALIAS = 'MRNE188';
const STATUS_PATH = '/ptp';

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

    // Log status + small preview (avoid huge logs)
    const preview =
      typeof response?.data === 'string'
        ? response.data.slice(0, 500)
        : JSON.stringify(response?.data || {}).slice(0, 1000);

    console.log('[MARINE] Status service success', {
      httpStatus: response?.status,
      dataPreview: preview
    });

    return response?.data || null;
  } catch (error) {
    console.error('[MARINE] Status service FAILED', {
      destination: DESTINATION,
      url: path,
      message: error?.message,
      status: error?.response?.status,
      responseData: error?.response?.data
    });
    return null;
  }
}

function normalizeStatusResponse(data) {
  const poItems = Array.isArray(data?.poItems) ? data.poItems : [];
  const prItems = Array.isArray(data?.prItems) ? data.prItems : [];
  const invoiceItems = Array.isArray(data?.invoiceItems) ? data.invoiceItems : [];
  const success =
    data?.success === true && (poItems.length > 0 || prItems.length > 0 || invoiceItems.length > 0);
  const totalCount = Number.isFinite(data?.totalCount) ? data.totalCount : Number(data?.totalCount);
  const resultCount = Number.isFinite(data?.resultCount) ? data.resultCount : Number(data?.resultCount);

  return {
    success,
    message: data?.message || '',
    searchValues: Array.isArray(data?.searchValues) ? data.searchValues : [],
    totalCount: Number.isNaN(totalCount) ? null : totalCount,
    resultCount: Number.isNaN(resultCount) ? null : resultCount,
    poItems,
    prItems,
    invoiceItems,
    raw: data
  };
}

function buildQueryParams(params) {
  const entries = Object.entries(params || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => [key, String(value)]);

  entries.push(['ISystemAlias', SYSTEM_ALIAS]);

  return entries.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`).join('&');
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

  const query = buildQueryParams({
    [docParam]: trimmedNumbers.join(',')
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
