/** Standard success envelope — all 2xx responses. */
export interface ApiSuccessResponse<T = unknown> {
  success: true;
  data: T;
  message?: string;
}

/** Standard error envelope — all 4xx/5xx responses. */
export interface ApiErrorResponse {
  success: false;
  statusCode: number;
  error: string;
  /** Single string or validation array from class-validator */
  message: string | string[];
  path?: string;
  timestamp?: string;
}

export type ApiResponse<T = unknown> = ApiSuccessResponse<T> | ApiErrorResponse;
