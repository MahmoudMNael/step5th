import { CACHE_MANAGER } from '@nestjs/cache-manager';
import {
	ConflictException,
	Inject,
	Injectable,
	NotFoundException,
	UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { JwtService } from '@nestjs/jwt';
import { Cache } from 'cache-manager';
import * as crypto from 'node:crypto';
import { UsersService } from 'src/users/users.service';
import { ConfirmRegisterRequestDto } from './dtos/confirm-register.dto';
import { LoginRequestDto } from './dtos/login.dto';
import { RegisterRequestDto } from './dtos/register.dto';

@Injectable()
export class AuthService {
	constructor(
		@Inject(CACHE_MANAGER) private readonly cacheManager: Cache,
		private readonly usersService: UsersService,
		private readonly eventEmitter: EventEmitter2,
		private readonly jwtService: JwtService,
	) {}

	//#region Registeration
	async register(registerDto: RegisterRequestDto) {
		const user = await this.usersService.findOne({ email: registerDto.email });

		if (user) {
			throw new ConflictException('User with that email already exists!');
		}

		const cacheKey = `register:${registerDto.email}`;

		const cachedData =
			await this.cacheManager.get<RegisterRequestDto>(cacheKey);

		if (cachedData) {
			throw new ConflictException(
				'User already registered! Awaiting email confirmation.',
			);
		}

		const verificationCode = Math.floor(
			100000 + Math.random() * 900000,
		).toString();

		this.cacheManager.set(
			cacheKey,
			{ userData: registerDto, verificationCode },
			10 * 60 * 1000,
		);

		this.eventEmitter.emit('user.registered', {
			email: registerDto.email,
			verificationCode,
		});
	}

	async confirmRegistration(confirmRegisterDto: ConfirmRegisterRequestDto) {
		const cacheKey = `register:${confirmRegisterDto.email}`;

		const cachedData = await this.cacheManager.get<{
			userData: RegisterRequestDto;
			verificationCode: string;
		}>(cacheKey);

		if (!cachedData) {
			throw new NotFoundException('Expired verification code!');
		}

		if (cachedData.verificationCode !== confirmRegisterDto.verificationCode) {
			throw new UnauthorizedException('Invalid verification code!');
		}

		const generatedSalt = this.generateSalt();
		const hashedPassword = this.hashPassword(
			cachedData.userData.password,
			generatedSalt,
		);

		const user = await this.usersService.create({
			...cachedData.userData,
			password: hashedPassword,
			salt: generatedSalt,
		});

		await this.cacheManager.del(cacheKey);

		this.eventEmitter.emit('user.registeration-confirmed', {
			email: cachedData.userData.email,
		});

		return {
			accessToken: this.signJwt({
				sub: user.id,
				email: user.email,
				role: user.role,
			}),
		};
	}
	//#endregion

	//#region Login
	signJwt(payload: { sub: string; email: string; role: string }) {
		const jwt = this.jwtService.sign(payload);
		return jwt;
	}

	async validateUser(email: string, password: string) {
		const user = await this.usersService.findOneWithPassword({ email });
		if (!user) {
			throw new NotFoundException('User not found!');
		}

		const isSamePassword = this.isSamePassword(
			password,
			user.password,
			user.salt,
		);

		if (!isSamePassword) {
			throw new UnauthorizedException('Invalid password!');
		}

		const { password: userPassword, salt: userSalt, ...result } = user;
		return result;
	}

	async login(loginRequestDto: LoginRequestDto) {
		const user = await this.validateUser(
			loginRequestDto.email,
			loginRequestDto.password,
		);

		return {
			accessToken: this.signJwt({
				sub: user.id,
				email: user.email,
				role: user.role,
			}),
		};
	}
	//#endregion

	//#region passwords
	private isSamePassword(
		password: string,
		storedPassword: string,
		salt: string,
	) {
		const hashedPassword = this.hashPassword(password, salt);

		return hashedPassword === storedPassword;
	}

	private hashPassword(password: string, salt: string) {
		return crypto
			.pbkdf2Sync(password, salt, 310000, 64, 'sha512')
			.toString('hex');
	}

	private generateSalt() {
		return crypto.randomBytes(16).toString('hex');
	}
	//#endregion

	async getProfile(id: string) {
		const user = await this.usersService.findOne({ id });

		if (!user) {
			throw new NotFoundException('User not found!');
		}

		return user;
	}
}
