import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { ApiSuccessResponse } from '../interfaces/api-response.interface';

/**
 * Wraps every successful controller return value as:
 * `{ success: true, data: <value> }`
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<
  T,
  ApiSuccessResponse<T>
> {
  intercept(
    _context: ExecutionContext,
    next: CallHandler,
  ): Observable<ApiSuccessResponse<T>> {
    return next.handle().pipe(
      map((payload) => {
        if (isAlreadyEnveloped(payload)) {
          return payload as ApiSuccessResponse<T>;
        }
        return {
          success: true as const,
          data: (payload === undefined ? null : payload) as T,
        };
      }),
    );
  }
}

function isAlreadyEnveloped(payload: unknown): boolean {
  return (
    typeof payload === 'object' &&
    payload !== null &&
    'success' in payload &&
    'data' in payload
  );
}
