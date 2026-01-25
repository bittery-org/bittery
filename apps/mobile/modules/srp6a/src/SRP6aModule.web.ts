// Web fallback - re-export the JavaScript implementation
// This is used when running in a web browser or during development on web
import { createSRPClient as jsCreateSRPClient, createSRPServer as jsCreateSRPServer, SRPError as jsSRPError } from '@bittery/srp6a'

export const createSRPClient = jsCreateSRPClient
export const createSRPServer = jsCreateSRPServer
export const SRPError = jsSRPError
