// Web fallback - re-export the JavaScript implementation
// This is used when running in a web browser or during development on web
// Import directly from the js-srp6a package in node_modules to avoid circular reference
import { createSRPClient as jsCreateSRPClient, createSRPServer as jsCreateSRPServer, SRPError as jsSRPError } from '../../../../node_modules/@bittery/srp6a'

export const createSRPClient = jsCreateSRPClient
export const createSRPServer = jsCreateSRPServer
export const SRPError = jsSRPError
