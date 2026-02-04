import Constants from "expo-constants";

const localIp = Constants.expoConfig?.hostUri?.split(":").shift();

export const defaultServerUrl = localIp
	? `http://${localIp}:3000`
	: "https://api.bittery.com";
